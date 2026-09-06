import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import type { RobotConfig } from "../config.js";
import { outPath } from "../config.js";
import { loadCases } from "../exec/runner.js";
import { DATA_RESOURCE_TYPES } from "../exec/types.js";
import type { Outcome, RunResult, Triage } from "../exec/types.js";
import type { TestCase } from "../synth/testcase.js";
import { NO_USAGE, addUsage, askJson, describeModel, estimateCost } from "../llm.js";

/**
 * Stage 4. The only place a model touches the execution path, and it touches it after
 * the fact.
 *
 * A failing test tells you something is wrong. It does not tell you *what* is wrong —
 * the application, the test, or the harness. That judgement needs the page as it stood
 * at failure, and it is the one part of this pipeline where a model genuinely beats a
 * heuristic.
 *
 * Triage is ADVISORY. It annotates an outcome and never changes its verdict. A model
 * that can quietly reclassify a real failure as a flake is not a triage system, it is a
 * way to make a red build go green — so that path does not exist here.
 */

export const triageSchema = z.object({
  classification: z.enum([
    /** The application is wrong. The test caught a genuine defect. */
    "REAL_BUG",
    /** The target moved or was renamed; the application behaviour is unchanged. */
    "SELECTOR_DRIFT",
    /** The expectation itself is wrong or over-specified. */
    "TEST_WRONG",
    /** Timing, ordering, or state leakage. Nothing to fix in either. */
    "ENV_FLAKE",
    /** The evidence does not support a call. */
    "UNDETERMINED",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
  repairTarget: z.enum(["application", "testcase", "harness", "none"]),
  suggestedRepair: z.string().optional(),
});

const SYSTEM = `
You triage a failing browser test. You are given the test case, the failure, and the state
of the page at the moment it failed.

Decide which of these it is:

- REAL_BUG — the application did the wrong thing. The expectation was reasonable and the
  application did not meet it.
- SELECTOR_DRIFT — the behaviour is intact but the test could not find its target: an
  element was renamed, a test id removed, a label reworded. Evidence: the accessibility
  snapshot shows an element that plainly plays the role the test was looking for, under a
  different name.
- TEST_WRONG — the expectation is itself incorrect: it asserts something no requirement
  supports, matches on text too brittly, or misreads the intended behaviour.
- ENV_FLAKE — timing, ordering, or leaked state. Note that assertions here already retry
  for five seconds before failing, so a plain "not yet rendered" is NOT a flake. Reserve
  this for genuine non-determinism.
- UNDETERMINED — the evidence does not support any of the above. Use it rather than
  guessing.

# How to read the evidence

- The accessibility snapshot is the page as it stood when the case failed. If the test was
  looking for an error message and the snapshot shows no error anywhere, the application
  did not produce one — that points to REAL_BUG, not drift.
- The request log shows what the page actually sent. A test asserting no request was sent,
  failing with a request present, is a real behavioural finding.
- The locator strategies show how each target resolved: "testid" is stable; a target that
  resolved by "text" or "role" when others resolved by "testid" is a drift signal.
- assertionSource matters. A "code"-sourced case only ever recorded what the code did, so
  its failure means behaviour changed — which may be an intentional change, not a bug.

# Discipline

Your judgement is advisory. It annotates the result; it does not change the verdict, and
nothing you say will turn a failure green. So there is no reason to hedge toward "flake"
to be safe, and no reason to call something a bug to be dramatic. Say what the evidence
supports.

Prefer UNDETERMINED with low confidence to a confident guess. Being wrong here costs an
engineer an hour looking in the wrong place.

Where you suggest a repair, be concrete and name the file, field, or expectation.
`.trim();

export interface AdjudicationReport {
  generatedAt: string;
  model: string;
  triaged: number;
  outcomes: Outcome[];
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
}

/** Verdicts worth spending a model call on. A PASS needs no explanation. */
const TRIAGEABLE = new Set(["FAIL", "BLOCKED", "FLAKE"]);

export async function adjudicate(config: RobotConfig): Promise<AdjudicationReport> {
  const runPath = path.join(config.root, config.outDir, "run.json");
  if (!fs.existsSync(runPath)) {
    throw new Error(`No run to adjudicate at ${runPath}. Run \`robot run\` first.`);
  }

  const run = JSON.parse(fs.readFileSync(runPath, "utf8")) as RunResult;
  const cases = new Map(loadCases(config).map((c) => [c.id, c]));
  const spec = fs.readFileSync(path.join(config.root, config.spec), "utf8");

  const failures = run.outcomes.filter((outcome) => TRIAGEABLE.has(outcome.verdict));
  if (failures.length === 0) {
    console.log("\n  Nothing to adjudicate — no failures in the last run.\n");
    return {
      generatedAt: new Date().toISOString(),
      model: describeModel(),
      triaged: 0,
      outcomes: run.outcomes,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  }

  let usageTotal = NO_USAGE;

  console.log(`\nAdjudicating ${failures.length} failure(s)\n`);

  for (const outcome of failures) {
    process.stdout.write(`  ${outcome.id} … `);

    const { value, usage } = await askJson({
      system: SYSTEM,
      user: brief(outcome, cases.get(outcome.id), spec),
      schema: triageSchema,
      maxTokens: 4000,
    });
    usageTotal = addUsage(usageTotal, usage);

    const triage = value as Triage | null;
    if (!triage) {
      console.log("could not parse a judgement");
      continue;
    }
    outcome.triage = triage;
    console.log(`${triage.classification} (${triage.confidence})`);
  }

  const report: AdjudicationReport = {
    generatedAt: new Date().toISOString(),
    model: describeModel(),
    triaged: failures.length,
    outcomes: run.outcomes,
    usage: {
      inputTokens: usageTotal.inputTokens,
      outputTokens: usageTotal.outputTokens,
      estimatedCostUsd: estimateCost(usageTotal),
    },
  };

  // Write the triage back onto the run so the two never drift apart.
  fs.writeFileSync(runPath, JSON.stringify(run, null, 2));
  fs.writeFileSync(
    outPath(config, "adjudication.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}

function brief(
  outcome: Outcome,
  testCase: TestCase | undefined,
  spec: string,
): string {
  const evidence = outcome.evidence;
  const requirement = outcome.specRef ? quoteRequirement(spec, outcome.specRef) : "";

  return `
# Failing case

id: ${outcome.id}
title: ${outcome.title}
screen: ${outcome.screen}
verdict: ${outcome.verdict}
assertionSource: ${outcome.assertionSource}${outcome.specRef ? ` (${outcome.specRef})` : ""}
detail: ${outcome.detail ?? "(none)"}

${requirement ? `# The requirement it claims to test\n\n${requirement}\n` : ""}
# The case as written

${testCase ? JSON.stringify(testCase, null, 2) : "(case not found on disk)"}

# Where it failed

phase: ${evidence?.phase ?? "unknown"} (index ${evidence?.index ?? "?"})
executing: ${evidence?.executing ?? "(unknown)"}
error: ${evidence?.errorName ?? ""} — ${evidence?.errorMessage ?? outcome.detail ?? ""}
url at failure: ${evidence?.url ?? "(unknown)"}

# How each target resolved

${
  Object.entries(outcome.locatorStrategies)
    .map(([target, strategy]) => `  ${target}: ${strategy}`)
    .join("\n") || "  (none resolved)"
}

# Data requests the page sent (documents, scripts and styles omitted)

${
  evidence?.requests
    ?.filter(
      (request) =>
        !request.resourceType || DATA_RESOURCE_TYPES.has(request.resourceType),
    )
    .map((request) => `  ${request.method} ${request.url}`)
    .join("\n") || "  (none)"
}

# Accessibility snapshot at the moment of failure

${evidence?.snapshot ?? "(not captured)"}

Classify this failure.
`.trim();
}

/** Pull one requirement's line out of the spec so the judgement can check it. */
function quoteRequirement(spec: string, specRef: string): string {
  return spec
    .split("\n")
    .filter((line) => line.includes(specRef))
    .join("\n")
    .trim();
}
