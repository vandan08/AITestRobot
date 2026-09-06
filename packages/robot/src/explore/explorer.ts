import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { RobotConfig } from "../config.js";
import { outPath } from "../config.js";
import { newContext, resetApp, setMutations } from "../harness.js";
import { NO_USAGE, describeModel, estimateCost, runTools } from "../llm.js";
import { loadCases, runSuite } from "../exec/runner.js";
import { validateCase } from "../synth/testcase.js";
import type { TestCase } from "../synth/testcase.js";
import type { Outcome, RequestLog } from "../exec/types.js";
import type { Usage } from "../llm.js";
import type { ToolResult } from "../providers/base.js";
import type { SurfaceMap } from "../types.js";
import { buildSurfaceMap } from "../surface/merge.js";
import { buildTools } from "./tools.js";
import type { ExploreSession } from "./tools.js";

/**
 * Explorer mode.
 *
 * The regression suite is deterministic, cheap and blind: it only ever checks what
 * someone already thought to write down. The explorer is the opposite — non-deterministic,
 * expensive, and capable of noticing things nobody specified. Running it on every commit
 * would be absurd; running it never means the corpus only grows when a human remembers to
 * grow it.
 *
 * So its output is not a verdict. It is *test cases*, which then go through the ordinary
 * compile-and-run path like anything else. The explorer discovers; the regression suite
 * decides. That separation is the whole point — see PLAN.md section 2.
 */

export interface ExploreOptions {
  screen?: string;
  as?: string;
  fixture?: string;
  /** Hard ceiling on agent turns. */
  maxIterations?: number;
  /** Stop once the run has cost this much, in USD. */
  budgetUsd?: number;
  /** Skip the verification pass (not recommended). */
  noVerify?: boolean;
}

export interface ExploreReport {
  generatedAt: string;
  screen: string;
  as: string;
  proposed: number;
  admitted: TestCase[];
  quarantined: Array<{ testCase: TestCase; verdict: string; detail?: string }>;
  rejected: string[];
  notes: string[];
  actions: number;
  turns: number;
  stopReason: ToolResult["stopReason"];
  model: string;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
}

function systemPrompt(spec: string): string {
  return `
You are exploring a running web application to find behaviour worth locking into a
regression suite.

# Your output

The ONLY thing that counts is calls to propose_case. Observing, clicking and reading are
all in service of that. A run that explores beautifully and proposes nothing has produced
nothing.

Each proposed case is replayed later from a fresh database reset, in a fresh browser, with
no memory of anything you did while exploring. So every case must stand alone: it must
start with a goto step, and its preconditions must state the fixture and the role it needs.
Do not propose a case that only works because of state you happen to have created.

# What exploring can and cannot tell you

Watching a running application teaches you what it DOES. It cannot tell you what it
SHOULD do. Those are different, and conflating them is the one mistake that would make
this whole exercise worthless.

So:
- Default every proposal to assertionSource "code". That is a characterization test: it
  records current behaviour so a future change is visible. It is not a claim the behaviour
  is right, and it is a perfectly respectable thing to produce.
- Use "spec" or "both" ONLY when a requirement below genuinely covers what you observed,
  and put its real id in specRef. Do not invent an id, and do not stretch a requirement to
  fit. A "spec" tag with nothing behind it is worse than no case at all.

If you observe something that seems to CONTRADICT a requirement, that is a real find:
propose the case from what the REQUIREMENT demands, tag it "spec", and say plainly in the
rationale that the application appeared to do otherwise. The case failing later is the
point.

# Where the value is

You are not here to re-cover ground the existing corpus already covers. You will be shown
what exists. Your value is entirely in the margin: the field nobody probed, the boundary
nobody tried, the control that behaves oddly, the save that reports success without
storing anything.

Habits worth having:
- After any save, call read_api and check the value actually landed. The form only shows
  you what you typed.
- Call requests to find out whether an action reached the server at all.
- Try the second side of a boundary, not just the first.
- Try a field with the wrong shape of data entirely.
- Notice controls that are present but do nothing.

Use note for anything worth a human's attention that you cannot turn into a case.

# Budget

Your turns are limited and each one costs real money. Prefer acting to deliberating. When
you have proposed what you can meaningfully find on this screen, say so and stop rather
than padding with near-duplicates.

# Requirements

${spec}
`.trim();
}

function mission(
  map: SurfaceMap,
  screenRoute: string,
  url: string,
  existing: TestCase[],
  as: string,
  fixture: string,
  roles: string[],
): string {
  const covered =
    existing
      .map((c) => `  ${c.id} [${c.assertionSource}] ${c.title}`)
      .join("\n") || "  (nothing yet — the corpus is empty)";

  const screen = map.screens.find((s) => s.route === screenRoute);

  return `
# Explore this screen

route: ${screenRoute}
start at: ${url}
you are signed in as: ${as}
database fixture: ${fixture}

# What the existing corpus already covers — do not repeat these

${covered}

# Declared validation rules (what the code enforces — not a claim of correctness)

${
  map.schemas
    .map((schema) =>
      schema.fields
        .map((field) => {
          const rules = field.rules
            .filter((rule) => rule.kind !== "type")
            .map((rule) =>
              rule.value === undefined
                ? rule.kind
                : `${rule.kind}=${JSON.stringify(rule.value)}`,
            )
            .join(", ");
          return `  ${field.name}: ${rules}`;
        })
        .join("\n"),
    )
    .join("\n") || "  (none)"
}

cross-field rules:
${
  map.schemas
    .flatMap((schema) =>
      schema.refinements.map(
        (r) => `  ${r.field}: "${r.message}" when \`${r.condition}\``,
      ),
    )
    .join("\n") || "  (none)"
}

# Available roles for preconditions

  ${roles.join(", ")}

# Available reset fixtures

  users.basic (5 staff), users.permissions (one per role), users.paging (25 staff)

# Starting page

${screen?.snapshot ?? "(call observe)"}

Begin. Call observe first if you need a fresher view, then explore.
`.trim();
}

export async function explore(
  config: RobotConfig,
  options: ExploreOptions = {},
): Promise<ExploreReport> {
  const map = await loadSurface(config);
  const spec = fs.readFileSync(path.join(config.root, config.spec), "utf8");

  const screen =
    map.screens.find((s) => s.reachable && s.route.includes(options.screen ?? "")) ??
    map.screens.find((s) => s.reachable);
  if (!screen) {
    throw new Error("No reachable screen to explore. Run `robot surface` first.");
  }

  const as = options.as ?? config.probeAs;
  const fixture = options.fixture ?? "users.basic";
  const maxIterations = options.maxIterations ?? 24;
  const budgetUsd = options.budgetUsd ?? 1.0;

  // The explorer works against a clean, unmutated application. Anything it finds is a
  // property of the real code, not of an injected defect.
  await resetApp(config, fixture);
  await setMutations(config, []);

  const browser = await chromium.launch();
  const context = await newContext(browser, config, as);
  const page = await context.newPage();
  const requests: RequestLog[] = [];
  page.on("request", (request) => {
    requests.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    });
  });

  const session: ExploreSession = {
    page,
    config,
    requests,
    proposals: [],
    notes: [],
    actions: 0,
  };

  let usage: Usage = NO_USAGE;
  let turns = 0;
  let stopReason: ToolResult["stopReason"] = "completed";

  try {
    await page.goto(`${config.baseUrl}${screen.url}`, {
      waitUntil: "networkidle",
      timeout: 15000,
    });

    console.log(
      `\nExploring ${screen.route} as ${as} with ${describeModel()}\n` +
        `  (max ${maxIterations} turns, budget $${budgetUsd.toFixed(2)})\n`,
    );

    const result = await runTools({
      system: systemPrompt(spec),
      user: mission(
        map,
        screen.route,
        screen.url,
        loadCases(config),
        as,
        fixture,
        Object.keys(config.auth.users),
      ),
      tools: buildTools(session),
      maxTokens: 8000,
      maxIterations,
      // A wandering agent is the expensive failure mode. Keep the brake here rather
      // than trusting the model to stop.
      onTurn: (running) => {
        turns += 1;
        usage = running;
        const spent = estimateCost(running);
        process.stdout.write(
          `  turn ${String(turns).padStart(2)}  ` +
            `${session.actions} actions  ${session.proposals.length} proposed  ` +
            `$${spent.toFixed(3)}\r`,
        );
        return spent < budgetUsd;
      },
    });

    usage = result.usage;
    turns = result.turns;
    stopReason = result.stopReason;
    console.log(`\n  stopped: ${stopReason}`);
  } finally {
    await context.close();
    await browser.close();
  }

  return finish(config, session, {
    screen: screen.route,
    as,
    turns,
    usage,
    stopReason,
    noVerify: options.noVerify ?? false,
  });
}

/**
 * Gatekeeping between a non-deterministic proposer and a deterministic corpus.
 *
 * Held to exactly the discipline synthesis is held to: a case claiming to test a
 * requirement must name a requirement that exists. Otherwise it is an assertion the
 * model liked the sound of, and admitting it would quietly reintroduce the tautology
 * this whole design exists to prevent.
 */
export function validateProposals(
  proposals: TestCase[],
  context: { spec: string; specPath: string; existingIds: Set<string> },
): { candidates: TestCase[]; rejected: string[] } {
  const candidates: TestCase[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const proposal of proposals) {
    // Namespace explorer output so it can never collide with hand-written or
    // synthesised cases.
    const id = proposal.id.startsWith("TC-EXP-")
      ? proposal.id
      : proposal.id.replace(/^(TC-)?/, "TC-EXP-");
    const testCase: TestCase = { ...proposal, id };

    const problems = validateCase(testCase);
    if (problems.length > 0) {
      rejected.push(problems[0]);
      continue;
    }
    if (testCase.assertionSource !== "code") {
      if (!testCase.specRef || !context.spec.includes(testCase.specRef)) {
        rejected.push(
          `${testCase.id}: claims ${testCase.assertionSource} but ` +
            `"${testCase.specRef ?? "no specRef"}" is not in ${context.specPath}`,
        );
        continue;
      }
    }
    if (seen.has(testCase.id) || context.existingIds.has(testCase.id)) {
      rejected.push(`${testCase.id}: duplicate id`);
      continue;
    }
    seen.add(testCase.id);
    candidates.push(testCase);
  }

  return { candidates, rejected };
}

async function finish(
  config: RobotConfig,
  session: ExploreSession,
  meta: {
    screen: string;
    as: string;
    turns: number;
    usage: Usage;
    stopReason: ToolResult["stopReason"];
    noVerify: boolean;
  },
): Promise<ExploreReport> {
  const spec = fs.readFileSync(path.join(config.root, config.spec), "utf8");
  const existing = new Set(loadCases(config).map((c) => c.id));
  const { candidates, rejected } = validateProposals(
    session.proposals,
    { spec, specPath: config.spec, existingIds: existing },
  );

  const report: ExploreReport = {
    generatedAt: new Date().toISOString(),
    model: describeModel(),
    screen: meta.screen,
    as: meta.as,
    proposed: session.proposals.length,
    admitted: [],
    quarantined: [],
    rejected,
    notes: session.notes,
    actions: session.actions,
    turns: meta.turns,
    stopReason: meta.stopReason,
    usage: {
      inputTokens: meta.usage.inputTokens,
      outputTokens: meta.usage.outputTokens,
      estimatedCostUsd: estimateCost(meta.usage),
    },
  };

  if (meta.noVerify || candidates.length === 0) {
    report.admitted = candidates;
    write(config, report);
    return report;
  }

  // Verification. A non-deterministic process feeding a deterministic suite is exactly
  // where flaky corpora come from, so nothing enters the suite until it has been replayed
  // from scratch against the clean application.
  console.log(`  verifying ${candidates.length} proposed case(s) against the clean app\n`);
  const verification = await runSuite(config, { cases: candidates, quiet: true });
  const byId = new Map(verification.outcomes.map((o: Outcome) => [o.id, o]));

  for (const testCase of candidates) {
    const outcome = byId.get(testCase.id);
    const verdict = outcome?.verdict ?? "BLOCKED";

    if (verdict === "PASS" || verdict === "CHARACTERIZED") {
      report.admitted.push(testCase);
    } else {
      // A FAIL here is NOT necessarily a bad case — a spec-sourced case that fails on
      // the clean application may have found a genuine defect. Quarantine means "a human
      // decides", not "wrong".
      report.quarantined.push({ testCase, verdict, detail: outcome?.detail });
    }
  }

  write(config, report);
  return report;
}

function write(config: RobotConfig, report: ExploreReport): void {
  const target = path.join(config.root, config.testcaseDir, "explored.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify(
      {
        _comment:
          "Discovered by `robot explore` and verified green against the clean app. " +
          "Quarantined proposals are in artifacts/explore.json, not here.",
        cases: report.admitted,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(outPath(config, "explore.json"), JSON.stringify(report, null, 2));
}

async function loadSurface(config: RobotConfig): Promise<SurfaceMap> {
  const cached = path.join(config.root, config.outDir, "surface.json");
  if (fs.existsSync(cached)) {
    return JSON.parse(fs.readFileSync(cached, "utf8")) as SurfaceMap;
  }
  return buildSurfaceMap(config);
}
