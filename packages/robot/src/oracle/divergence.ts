import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import type { RobotConfig } from "../config.js";
import { outPath } from "../config.js";
import { buildSurfaceMap } from "../surface/merge.js";
import type { SurfaceMap } from "../types.js";
import { askJson, describeModel, estimateCost } from "../llm.js";

/**
 * The third verdict.
 *
 * A test suite can only ever tell you whether the application matches the code's own
 * idea of correct. It cannot tell you that a requirement never reached the code at all —
 * there is nothing to execute, so nothing fails, and the gap is invisible forever.
 *
 * This compares the requirements against the rules extracted in Stage 1 and reports where
 * they disagree. It runs before any browser opens, and it is the finding this whole design
 * exists to surface.
 */

export const divergenceFindingSchema = z.object({
  kind: z.enum([
    /** The spec asserts something the code contradicts. */
    "contradiction",
    /** The spec asserts a rule with no counterpart in the code at all. */
    "unimplemented",
    /** The code enforces a rule no requirement covers. */
    "undocumented",
  ]),
  severity: z.enum(["high", "medium", "low"]),
  /** Requirement id. Required for contradiction and unimplemented. */
  specRef: z.string().optional(),
  /** The requirement's own words, verbatim. No paraphrasing. */
  specQuote: z.string().optional(),
  /** The extracted rule, named exactly as Stage 1 reported it. */
  codeRule: z.string().optional(),
  codeSource: z.string().optional(),
  field: z.string().optional(),
  summary: z.string(),
  detail: z.string(),
  /**
   * Whether an executable case could demonstrate this. An unimplemented requirement
   * usually can be; an undocumented code rule usually only yields a "code" case.
   */
  testable: z.boolean(),
});

export const divergenceReportSchema = z.object({
  findings: z.array(divergenceFindingSchema),
});

export type DivergenceFinding = z.infer<typeof divergenceFindingSchema>;

export interface DivergenceReport {
  generatedAt: string;
  /** Which provider and model produced this. */
  model: string;
  findings: DivergenceFinding[];
  rejected: string[];
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
}

const SYSTEM = `
You compare a requirements document against validation rules extracted from an
application's source, and report only where the two genuinely disagree.

# What you are given

- REQUIREMENTS: written by a person, in prose, with ids. This says what SHOULD be true.
- EXTRACTED RULES: read mechanically off the source by an AST walk. This is a complete and
  accurate account of what the code ACTUALLY enforces. It is not a claim of correctness.

The extraction is complete. If a rule is not in the list, the code does not enforce it —
do not assume an unlisted rule exists somewhere you cannot see.

# What to report

- "contradiction" — the requirement asserts something and the code enforces the opposite.
  Example shape: the spec makes a field mandatory; the schema marks it optional.
- "unimplemented" — the requirement states a rule and no extracted rule corresponds to it.
- "undocumented" — the code enforces a rule that no requirement covers. Worth knowing:
  tests for it can only ever record current behaviour, never assert correctness.

# Discipline

You must be able to quote both sides. For every contradiction and unimplemented finding,
give the requirement id and its text verbatim in specQuote, and name the extracted rule
exactly as it appears in codeRule. If you cannot quote both sides, do not report it.

Prefer silence to speculation. A false divergence sends someone to read code for an hour
to find nothing, and it teaches them to ignore this report. Reporting nothing is a
perfectly good outcome.

Do NOT report:
- A requirement about behaviour that validation rules could not express anyway (server
  uniqueness, authorization, persistence) unless the extracted surface positively shows
  it missing. Absence from a *validation schema* is not evidence for these.
- Wording differences where the rule plainly matches.
- Rules whose message text differs from the requirement's phrasing but whose effect is
  the same.
- Anything you would describe with "may", "might", or "could be".
`.trim();

export async function detectDivergence(
  config: RobotConfig,
): Promise<DivergenceReport> {
  const map = await loadSurface(config);
  const spec = fs.readFileSync(path.join(config.root, config.spec), "utf8");

  const { value: parsed, usage } = await askJson({
    system: SYSTEM,
    user: brief(spec, map),
    schema: divergenceReportSchema,
    maxTokens: 16000,
  });

  const findings: DivergenceFinding[] = [];
  const rejected: string[] = [];

  for (const finding of parsed?.findings ?? []) {
    // A finding you cannot check is worse than no finding.
    if (finding.kind !== "undocumented" && !finding.specRef) {
      rejected.push(`${finding.summary} — no specRef`);
      continue;
    }
    if (finding.kind !== "undocumented" && !finding.specQuote) {
      rejected.push(`${finding.specRef}: no verbatim requirement quote`);
      continue;
    }
    if (finding.specRef && !spec.includes(finding.specRef)) {
      rejected.push(`${finding.specRef}: no such requirement in ${config.spec}`);
      continue;
    }
    findings.push(finding);
  }

  const report: DivergenceReport = {
    generatedAt: new Date().toISOString(),
    model: describeModel(),
    findings,
    rejected,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd: estimateCost(usage),
    },
  };

  fs.writeFileSync(outPath(config, "divergence.json"), JSON.stringify(report, null, 2));
  return report;
}

function brief(spec: string, map: SurfaceMap): string {
  const rules = map.schemas
    .map((schema) => {
      const fields = schema.fields
        .map((field) => {
          const parts = field.rules
            .filter((rule) => rule.kind !== "type")
            .map((rule) => {
              const value =
                rule.value === undefined ? "" : `=${JSON.stringify(rule.value)}`;
              return `${rule.kind}${value}`;
            })
            .join(", ");
          const source = field.rules[0]?.source ?? "";
          return `  ${schema.name}.${field.name} (${field.type}) [${source}]: ${parts}`;
        })
        .join("\n");

      const refinements = schema.refinements
        .map(
          (refinement) =>
            `  ${schema.name}.${refinement.field} [${refinement.source}]: ` +
            `raises "${refinement.message}" when \`${refinement.condition}\``,
        )
        .join("\n");

      return `${fields}\n\ncross-field rules:\n${refinements}`;
    })
    .join("\n\n");

  return `
# REQUIREMENTS

${spec}

# EXTRACTED RULES (complete — read from source by AST walk)

${rules}

# Routes

${map.routes.map((route) => `  ${route.path}`).join("\n")}

# API endpoints

${map.endpoints.map((endpoint) => `  ${endpoint.method} ${endpoint.path}`).join("\n")}

Report the divergences now.
`.trim();
}

async function loadSurface(config: RobotConfig): Promise<SurfaceMap> {
  const cached = path.join(config.root, config.outDir, "surface.json");
  if (fs.existsSync(cached)) {
    return JSON.parse(fs.readFileSync(cached, "utf8")) as SurfaceMap;
  }
  return buildSurfaceMap(config);
}
