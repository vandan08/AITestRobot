import fs from "node:fs";
import type { RobotConfig } from "../config.js";
import { outPath } from "../config.js";
import { listMutations } from "../harness.js";
import { runSuite } from "../exec/runner.js";
import type { Outcome } from "../exec/types.js";

/**
 * Does the corpus actually work?
 *
 * "It generated 400 test cases" is not a result. This is: inject one known defect at a
 * time and measure what fraction the suite catches. The mutations that survive tell you
 * exactly where generation is weak — which is the research output. See PLAN.md section 6.
 */

interface MutationResult {
  id: string;
  specRef: string;
  class: string;
  description: string;
  caught: boolean;
  /** Cases that reported a real FAIL — only spec-sourced ones count. */
  caughtBy: string[];
}

export interface EvalReport {
  generatedAt: string;
  corpusSize: number;
  baseline: { pass: number; falsePositives: string[]; blocked: string[] };
  mutations: MutationResult[];
  score: { caught: number; total: number; percent: number };
  falsePositiveRate: number;
  blockedRate: number;
  durationMs: number;
}

/** Only a spec-sourced FAIL counts as a catch. A characterization test cannot indict. */
function realFailures(outcomes: Outcome[]): Outcome[] {
  return outcomes.filter(
    (outcome) => outcome.verdict === "FAIL" && outcome.assertionSource !== "code",
  );
}

export async function runEval(config: RobotConfig): Promise<EvalReport> {
  const started = Date.now();
  const { available } = await listMutations(config);

  console.log(`\nBaseline — unmutated application`);
  const baseline = await runSuite(config, { mutations: [], quiet: true });

  const falsePositives = realFailures(baseline.outcomes).map((o) => o.id);
  const blocked = baseline.outcomes
    .filter((o) => o.verdict === "BLOCKED")
    .map((o) => o.id);

  console.log(
    `  ${baseline.total} cases  ${baseline.pass} pass  ` +
      `${falsePositives.length} false positives  ${blocked.length} blocked`,
  );
  if (falsePositives.length > 0) {
    console.log(`  ! a suite that fails on the correct application cannot measure anything`);
    for (const id of falsePositives) console.log(`    ${id}`);
  }

  console.log(`\nInjecting ${available.length} defects, one at a time`);
  const results: MutationResult[] = [];

  for (const mutation of available) {
    const run = await runSuite(config, { mutations: [mutation.id], quiet: true });
    // A case that already fails on the clean app proves nothing here.
    const caughtBy = realFailures(run.outcomes)
      .map((o) => o.id)
      .filter((id) => !falsePositives.includes(id));

    results.push({
      id: mutation.id,
      specRef: mutation.specRef,
      class: mutation.class,
      description: mutation.description,
      caught: caughtBy.length > 0,
      caughtBy,
    });

    const mark = caughtBy.length > 0 ? "caught  " : "SURVIVED";
    console.log(
      `  ${mark} ${mutation.id.padEnd(20)} ${mutation.specRef.padEnd(9)} ` +
        (caughtBy.length > 0 ? caughtBy.join(", ") : mutation.description),
    );
  }

  const caught = results.filter((result) => result.caught).length;
  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    corpusSize: baseline.total,
    baseline: { pass: baseline.pass, falsePositives, blocked },
    mutations: results,
    score: {
      caught,
      total: results.length,
      percent: Math.round((caught / results.length) * 100),
    },
    falsePositiveRate: falsePositives.length / Math.max(1, baseline.total),
    blockedRate: blocked.length / Math.max(1, baseline.total),
    durationMs: Date.now() - started,
  };

  print(report);
  fs.writeFileSync(outPath(config, "eval.json"), JSON.stringify(report, null, 2));
  return report;
}

function print(report: EvalReport): void {
  const survivors = report.mutations.filter((mutation) => !mutation.caught);

  console.log(`\nScorecard`);
  console.log(`  mutation score      ${report.score.caught}/${report.score.total}  (${report.score.percent}%)`);
  console.log(`  corpus size         ${report.corpusSize} cases`);
  console.log(`  false positives     ${(report.falsePositiveRate * 100).toFixed(1)}%`);
  console.log(`  blocked             ${(report.blockedRate * 100).toFixed(1)}%`);
  console.log(`  duration            ${(report.durationMs / 1000).toFixed(1)}s`);

  if (survivors.length > 0) {
    console.log(`\n  Survivors — where the corpus is blind:`);
    for (const survivor of survivors) {
      console.log(`    ${survivor.id.padEnd(20)} ${survivor.class.padEnd(20)} ${survivor.specRef}`);
      console.log(`      ${survivor.description}`);
    }
  }
  console.log();
}
