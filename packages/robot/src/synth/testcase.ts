// zod/v4 specifically: the SDK's `zodOutputFormat` helper is typed against the v4
// internals, and a v3-classic schema will not satisfy it.
import { z } from "zod/v4";

/**
 * The TestCase DSL.
 *
 * This is the artifact the model produces and the executor consumes — data, not prose and
 * not code. It is written to disk, reviewed by a human, committed, and then replayed
 * thousands of times with zero inference. See PLAN.md section 4.
 *
 * Deliberately flat: this schema is also handed to the API as a structured-output format,
 * and shallow shapes survive that round trip far more reliably than deep unions.
 */

export const ACTIONS = [
  "goto",
  "fill",
  "select",
  "check",
  "uncheck",
  "click",
  "waitFor",
] as const;

export const ASSERTIONS = [
  "visible",
  "hidden",
  "text",
  "value",
  "url",
  "enabled",
  "disabled",
  "count",
  "apiCalled",
  "apiNotCalled",
  "persisted",
] as const;

export const stepSchema = z.object({
  action: z.enum(ACTIONS),
  /** A semantic name — never a CSS selector or coordinates. */
  target: z.string().optional(),
  value: z.string().optional(),
});

export const expectationSchema = z.object({
  assert: z.enum(ASSERTIONS),
  target: z.string().optional(),
  /** Substring the target's text must contain. */
  match: z.string().optional(),
  value: z.string().optional(),
});

export const preconditionSchema = z.object({
  type: z.enum(["reset", "auth"]),
  /** Fixture name for `reset`, role name for `auth`. */
  value: z.string().optional(),
});

export const testCaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  screen: z.string(),
  feature: z.string(),
  kind: z.enum(["happy", "boundary", "negative", "permission", "persistence"]),
  priority: z.enum(["P1", "P2", "P3"]),

  /**
   * The oracle discipline, made mechanical.
   *
   * "spec"  — traces to a requirement; may report a real FAIL.
   * "code"  — read off the implementation; a characterization test. Its failure means
   *           "behaviour changed", never "behaviour is wrong".
   * "both"  — spec and code agree. Strongest signal.
   */
  assertionSource: z.enum(["spec", "code", "both"]),
  /** Required whenever assertionSource is "spec" or "both". */
  specRef: z.string().optional(),
  /** Why this expectation is correct. Forces the model to show its working. */
  rationale: z.string(),

  preconditions: z.array(preconditionSchema),
  steps: z.array(stepSchema),
  expected: z.array(expectationSchema),
});

export const testSuiteSchema = z.object({
  cases: z.array(testCaseSchema),
});

export type Step = z.infer<typeof stepSchema>;
export type Expectation = z.infer<typeof expectationSchema>;
export type Precondition = z.infer<typeof preconditionSchema>;
export type TestCase = z.infer<typeof testCaseSchema>;
export type TestSuite = z.infer<typeof testSuiteSchema>;

/**
 * Structural rules the model must not break. Enforced after generation, because a
 * spec-sourced case with no requirement behind it is exactly the tautology this whole
 * design exists to prevent.
 */
export function validateCase(testCase: TestCase): string[] {
  const problems: string[] = [];

  if (testCase.assertionSource !== "code" && !testCase.specRef) {
    problems.push(
      `${testCase.id}: assertionSource "${testCase.assertionSource}" requires a specRef`,
    );
  }
  if (testCase.expected.length === 0) {
    problems.push(`${testCase.id}: no expectations — the case asserts nothing`);
  }
  if (!testCase.steps.some((step) => step.action === "goto")) {
    problems.push(`${testCase.id}: no goto step — the case never opens a screen`);
  }
  for (const step of testCase.steps) {
    if (step.action !== "goto" && !step.target) {
      problems.push(`${testCase.id}: "${step.action}" step is missing a target`);
    }
  }
  return problems;
}
