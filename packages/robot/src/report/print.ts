import type { SurfaceMap } from "../types.js";
import type { RunResult } from "../exec/types.js";
import type { AdjudicationReport } from "../adjudicate/triage.js";
import type { DivergenceReport } from "../oracle/divergence.js";
import type { ExploreReport } from "../explore/explorer.js";

const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;

export function printSurface(map: SurfaceMap, target: string): void {
  console.log(`\n${BOLD}Surface map${RESET} — ${map.appName}`);
  console.log(`${DIM}${target}${RESET}\n`);

  console.log(`  routes     ${map.routes.length}`);
  for (const route of map.routes) {
    console.log(`    ${route.path.padEnd(20)} ${DIM}${route.component}${RESET}`);
  }

  console.log(`\n  endpoints  ${map.endpoints.length}`);
  for (const endpoint of map.endpoints) {
    console.log(`    ${endpoint.method.padEnd(7)} ${endpoint.path}`);
  }

  console.log(`\n  schemas    ${map.schemas.length}`);
  for (const schema of map.schemas) {
    console.log(`    ${BOLD}${schema.name}${RESET}  ${schema.fields.length} fields`);
    for (const field of schema.fields) {
      const rules = field.rules
        .filter((rule) => rule.kind !== "type")
        .map((rule) =>
          rule.value === undefined
            ? rule.kind
            : `${rule.kind}=${JSON.stringify(rule.value)}`,
        )
        .join(" ");
      console.log(
        `      ${field.name.padEnd(20)} ${DIM}${field.type.padEnd(8)}${RESET} ${rules}`,
      );
    }
    if (schema.refinements.length > 0) {
      console.log(`      ${DIM}cross-field:${RESET}`);
      for (const refinement of schema.refinements) {
        console.log(
          `        ${refinement.field} ${DIM}when${RESET} ${refinement.condition}`,
        );
      }
    }
  }

  console.log(`\n  screens    ${map.screens.length}`);
  for (const screen of map.screens) {
    const state = screen.reachable ? `${GREEN}ok${RESET}` : `${RED}unreachable${RESET}`;
    console.log(
      `    ${screen.route.padEnd(20)} ${state}  ${screen.controls.length} controls  ` +
        `${DIM}${screen.snapshot.length} snapshot chars${RESET}`,
    );
  }

  if (map.findings.length > 0) {
    console.log(`\n  ${YELLOW}findings   ${map.findings.length}${RESET}`);
    for (const finding of map.findings) {
      console.log(`    ${YELLOW}!${RESET} ${BOLD}${finding.kind}${RESET} ${finding.subject}`);
      console.log(`      ${DIM}${finding.detail}${RESET}`);
    }
  } else {
    console.log(`\n  ${GREEN}no extraction findings${RESET}`);
  }
  console.log();
}

const VERDICT_COLOR: Record<string, string> = {
  PASS: GREEN,
  FAIL: RED,
  DIVERGENCE: YELLOW,
  CHARACTERIZED: CYAN,
  FLAKE: YELLOW,
  BLOCKED: YELLOW,
};

export function printRun(result: RunResult): void {
  console.log(`\n${BOLD}Run${RESET} — ${result.total} cases in ${result.durationMs}ms`);
  if (result.mutations.length > 0) {
    console.log(`${YELLOW}mutations armed: ${result.mutations.join(", ")}${RESET}`);
  }
  console.log();

  for (const outcome of result.outcomes) {
    const color = VERDICT_COLOR[outcome.verdict] ?? "";
    console.log(
      `  ${color}${outcome.verdict.padEnd(14)}${RESET} ${outcome.id.padEnd(34)} ` +
        `${DIM}${outcome.title}${RESET}`,
    );
    if (outcome.detail) {
      console.log(`  ${" ".repeat(14)} ${DIM}${outcome.detail}${RESET}`);
    }
  }

  const counts = result.outcomes.reduce<Record<string, number>>((acc, outcome) => {
    acc[outcome.verdict] = (acc[outcome.verdict] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `\n  ${Object.entries(counts)
      .map(([verdict, n]) => `${VERDICT_COLOR[verdict] ?? ""}${verdict} ${n}${RESET}`)
      .join("   ")}\n`,
  );

  if (counts.CHARACTERIZED) {
    console.log(
      `  ${DIM}CHARACTERIZED is not a pass — those cases assert what the code does,\n` +
        `  not what it should do. Only spec-sourced cases can report a real FAIL.${RESET}\n`,
    );
  }
}

const CLASSIFICATION_COLOR: Record<string, string> = {
  REAL_BUG: RED,
  SELECTOR_DRIFT: YELLOW,
  TEST_WRONG: CYAN,
  ENV_FLAKE: YELLOW,
  UNDETERMINED: DIM,
};

export function printAdjudication(report: AdjudicationReport): void {
  const triaged = report.outcomes.filter((outcome) => outcome.triage);
  if (triaged.length === 0) return;

  console.log(`\n${BOLD}Adjudication${RESET}\n`);

  for (const outcome of triaged) {
    const triage = outcome.triage!;
    const color = CLASSIFICATION_COLOR[triage.classification] ?? "";
    console.log(
      `  ${color}${triage.classification.padEnd(15)}${RESET}` +
        `${DIM}${triage.confidence.padEnd(8)}${RESET} ${outcome.id}`,
    );
    console.log(`    ${triage.reasoning}`);
    if (triage.suggestedRepair) {
      console.log(`    ${DIM}fix in ${triage.repairTarget}:${RESET} ${triage.suggestedRepair}`);
    }
    console.log();
  }

  console.log(
    `  ${DIM}Advisory only. Every verdict above stands unchanged — triage explains a\n` +
      `  failure, it does not resolve one.${RESET}`,
  );
  console.log(
    `  ${DIM}~$${report.usage.estimatedCostUsd.toFixed(3)} for ${report.triaged} judgement(s)${RESET}\n`,
  );
}

export function printExplore(report: ExploreReport): void {
  console.log(`\n${BOLD}Exploration${RESET} — ${report.screen} as ${report.as}\n`);
  console.log(
    `  ${report.turns} turns  ${report.actions} actions  ` +
      `${report.proposed} proposed  ${DIM}~$${report.usage.estimatedCostUsd.toFixed(3)}${RESET}\n`,
  );

  if (report.admitted.length > 0) {
    console.log(`  ${GREEN}admitted to the corpus${RESET}  (${report.admitted.length})`);
    for (const testCase of report.admitted) {
      console.log(
        `    ${testCase.id.padEnd(34)} ${DIM}[${testCase.assertionSource}]${RESET} ${testCase.title}`,
      );
    }
    console.log();
  }

  if (report.quarantined.length > 0) {
    console.log(`  ${YELLOW}quarantined — a human decides${RESET}  (${report.quarantined.length})`);
    for (const entry of report.quarantined) {
      const color = VERDICT_COLOR[entry.verdict] ?? "";
      console.log(
        `    ${color}${entry.verdict.padEnd(14)}${RESET} ${entry.testCase.id} ` +
          `${DIM}[${entry.testCase.assertionSource}${entry.testCase.specRef ? ` ${entry.testCase.specRef}` : ""}]${RESET}`,
      );
      console.log(`      ${entry.testCase.title}`);
      if (entry.detail) console.log(`      ${DIM}${entry.detail}${RESET}`);
    }
    console.log(
      `\n    ${DIM}A spec-sourced case failing on the clean application may have found a\n` +
        `    real defect. Quarantined means unverified, not wrong — review before\n` +
        `    discarding, and \`robot adjudicate\` can help.${RESET}\n`,
    );
  }

  if (report.notes.length > 0) {
    console.log(`  ${BOLD}notes${RESET}  (${report.notes.length})`);
    for (const note of report.notes) console.log(`    ${note}`);
    console.log();
  }

  if (report.rejected.length > 0) {
    console.log(`  ${DIM}${report.rejected.length} proposal(s) rejected before verification:${RESET}`);
    for (const reason of report.rejected) console.log(`    ${DIM}${reason}${RESET}`);
    console.log();
  }

  if (report.proposed === 0) {
    console.log(
      `  ${YELLOW}Nothing proposed.${RESET} ${DIM}The explorer produced no cases — either the\n` +
        `  screen is already well covered, or the budget ran out first.${RESET}\n`,
    );
  }
}

const SEVERITY_COLOR: Record<string, string> = {
  high: RED,
  medium: YELLOW,
  low: DIM,
};

export function printDivergence(report: DivergenceReport): void {
  console.log(`\n${BOLD}Divergence${RESET} — requirements against extracted rules\n`);

  if (report.findings.length === 0) {
    console.log(`  ${GREEN}No divergence found.${RESET}`);
    console.log(
      `  ${DIM}Silence is a valid result here — it means every requirement that could be\n` +
        `  expressed as a validation rule reached the code.${RESET}\n`,
    );
  }

  const order = ["contradiction", "unimplemented", "undocumented"];
  for (const kind of order) {
    const group = report.findings.filter((finding) => finding.kind === kind);
    if (group.length === 0) continue;

    console.log(`  ${BOLD}${kind}${RESET}  (${group.length})`);
    for (const finding of group) {
      const color = SEVERITY_COLOR[finding.severity] ?? "";
      console.log(
        `    ${color}${finding.severity.padEnd(7)}${RESET} ` +
          `${finding.specRef ? `${finding.specRef}  ` : ""}${finding.summary}`,
      );
      if (finding.specQuote) {
        console.log(`      ${DIM}spec:${RESET} "${finding.specQuote}"`);
      }
      if (finding.codeRule) {
        console.log(
          `      ${DIM}code:${RESET} ${finding.codeRule}` +
            (finding.codeSource ? ` ${DIM}(${finding.codeSource})${RESET}` : ""),
        );
      }
      console.log(`      ${DIM}${finding.detail}${RESET}`);
      if (!finding.testable) {
        console.log(`      ${DIM}not demonstrable by an executable case${RESET}`);
      }
      console.log();
    }
  }

  if (report.rejected.length > 0) {
    console.log(`  ${DIM}${report.rejected.length} finding(s) rejected as uncheckable:${RESET}`);
    for (const reason of report.rejected) {
      console.log(`    ${DIM}${reason}${RESET}`);
    }
    console.log();
  }

  console.log(
    `  ${DIM}~$${report.usage.estimatedCostUsd.toFixed(3)}${RESET}\n`,
  );
}
