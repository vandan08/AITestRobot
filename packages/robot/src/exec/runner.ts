import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { RobotConfig } from "../config.js";
import { outPath } from "../config.js";
import { newContext, resetApp, setMutations } from "../harness.js";
import { testCaseSchema, validateCase } from "../synth/testcase.js";
import type { TestCase } from "../synth/testcase.js";
import { AssertionFailure, checkExpectation, runStep } from "./actions.js";
import { LocatorError } from "./locator.js";
import type { Strategy } from "./locator.js";
import type { Evidence, Outcome, RequestLog, RunResult, Verdict } from "./types.js";
import { printRun } from "../report/print.js";

export interface RunOptions {
  filter?: string;
  mutations?: string[];
  quiet?: boolean;
  /**
   * Run these cases instead of what is on disk. Used to verify explorer proposals
   * before they are allowed anywhere near the committed corpus.
   */
  cases?: TestCase[];
}

export function loadCases(config: RobotConfig): TestCase[] {
  const dir = path.join(config.root, config.testcaseDir);
  if (!fs.existsSync(dir)) return [];

  const cases: TestCase[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const list = Array.isArray(parsed) ? parsed : (parsed.cases ?? []);
    for (const entry of list) {
      cases.push(testCaseSchema.parse(entry));
    }
  }
  return cases;
}

export async function runSuite(
  config: RobotConfig,
  options: RunOptions = {},
): Promise<RunResult> {
  const all = options.cases ?? loadCases(config);
  const cases = options.filter
    ? all.filter(
        (c) =>
          c.id.includes(options.filter!) ||
          c.screen.includes(options.filter!) ||
          c.feature.includes(options.filter!),
      )
    : all;

  if (cases.length === 0) {
    throw new Error(
      `No test cases in ${config.testcaseDir}/` +
        (options.filter ? ` matching "${options.filter}"` : "") +
        `. Run "robot synth" first.`,
    );
  }

  const started = Date.now();
  const browser = await chromium.launch();
  const outcomes: Outcome[] = [];

  try {
    for (const testCase of cases) {
      outcomes.push(await runCase(browser, config, testCase, options.mutations ?? []));
    }
  } finally {
    await browser.close();
    // Never leave the app mutated for the next run.
    await setMutations(config, []).catch(() => {});
  }

  const result: RunResult = {
    total: outcomes.length,
    pass: outcomes.filter((o) => o.verdict === "PASS").length,
    fail: outcomes.filter((o) => o.verdict === "FAIL").length,
    blocked: outcomes.filter((o) => o.verdict === "BLOCKED").length,
    characterized: outcomes.filter((o) => o.verdict === "CHARACTERIZED").length,
    durationMs: Date.now() - started,
    mutations: options.mutations ?? [],
    outcomes,
  };

  // A verification pass over a caller-supplied list is not a run of the corpus, so it
  // must not overwrite the record that `robot adjudicate` reads.
  if (!options.cases) {
    fs.writeFileSync(outPath(config, "run.json"), JSON.stringify(result, null, 2));
  }
  if (!options.quiet) printRun(result);
  return result;
}

async function runCase(
  browser: Browser,
  config: RobotConfig,
  testCase: TestCase,
  mutations: string[],
): Promise<Outcome> {
  const started = Date.now();
  const strategies: Record<string, Strategy> = {};

  const base = {
    id: testCase.id,
    title: testCase.title,
    screen: testCase.screen,
    assertionSource: testCase.assertionSource,
    specRef: testCase.specRef,
    locatorStrategies: strategies,
  };

  const structural = validateCase(testCase);
  if (structural.length > 0) {
    return {
      ...base,
      verdict: "BLOCKED",
      detail: structural[0],
      durationMs: Date.now() - started,
    };
  }

  // Preconditions first, and always in this order: state, then mutations, then auth.
  const fixture =
    testCase.preconditions.find((p) => p.type === "reset")?.value ?? "users.basic";
  const authAs = testCase.preconditions.find((p) => p.type === "auth")?.value;

  let context;
  try {
    await resetApp(config, fixture);
    // resetApp clears mutations, so arm them after it — not before.
    if (mutations.length > 0) await setMutations(config, mutations);
    context = await newContext(browser, config, authAs);
  } catch (error) {
    return {
      ...base,
      verdict: "BLOCKED",
      detail: `precondition failed: ${(error as Error).message}`,
      // No page exists yet, so there is nothing to snapshot — but the harness error
      // itself is what triage needs here.
      evidence: {
        phase: "precondition",
        index: 0,
        executing: JSON.stringify({ fixture, authAs }),
        requests: [],
        errorName: (error as Error).name,
        errorMessage: (error as Error).message.split("\n")[0],
      },
      durationMs: Date.now() - started,
    };
  }

  const page = await context.newPage();
  const requests: RequestLog[] = [];
  page.on("request", (request) => {
    requests.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    });
  });

  const ctx = { page, config, requests, strategies };
  let phase: Evidence["phase"] = "steps";
  let index = 0;
  let executing: string | undefined;

  try {
    for (const [i, step] of testCase.steps.entries()) {
      phase = "steps";
      index = i;
      executing = JSON.stringify(step);
      await runStep(step, ctx);
    }
    for (const [i, expectation] of testCase.expected.entries()) {
      phase = "expectations";
      index = i;
      executing = JSON.stringify(expectation);
      await checkExpectation(expectation, ctx);
    }

    return {
      ...base,
      verdict: verdictForPass(testCase),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      ...classify(error as Error, testCase),
      evidence: await captureEvidence(page, requests, error as Error, {
        phase,
        index,
        executing,
      }),
      durationMs: Date.now() - started,
    };
  } finally {
    await context.close();
  }
}

/**
 * Evidence is gathered only on failure, and gathering it must never itself throw —
 * a page that has navigated away or crashed still has to produce a triageable record.
 */
async function captureEvidence(
  page: Page,
  requests: RequestLog[],
  error: Error,
  at: { phase: Evidence["phase"]; index: number; executing?: string },
): Promise<Evidence> {
  const evidence: Evidence = {
    ...at,
    requests: [...requests],
    errorName: error.name,
    errorMessage: error.message.split("\n").slice(0, 4).join(" "),
  };

  try {
    evidence.url = page.url();
    evidence.snapshot = await page.locator("body").ariaSnapshot();
  } catch {
    // The page is gone. The rest of the record still triages.
  }
  return evidence;
}

/**
 * A code-sourced case that behaves as recorded is CHARACTERIZED, not PASS.
 *
 * It asserts that the code does what the code does, which is a regression signal and
 * nothing more. Reporting it as a green tick is precisely how these tools end up lying
 * to the people reading their output.
 */
function verdictForPass(testCase: TestCase): Verdict {
  return testCase.assertionSource === "code" ? "CHARACTERIZED" : "PASS";
}

function classify(
  error: Error,
  testCase: TestCase,
): { verdict: Verdict; detail: string } {
  if (error instanceof LocatorError) {
    return { verdict: "BLOCKED", detail: error.message };
  }

  if (error instanceof AssertionFailure) {
    // Only a spec-sourced expectation can indict the application.
    if (testCase.assertionSource === "code") {
      return {
        verdict: "CHARACTERIZED",
        detail: `behaviour changed since capture: ${error.message}`,
      };
    }
    return { verdict: "FAIL", detail: error.message };
  }

  if (/timeout/i.test(error.message)) {
    return { verdict: "FLAKE", detail: error.message.split("\n")[0] };
  }

  return { verdict: "BLOCKED", detail: error.message.split("\n")[0] };
}
