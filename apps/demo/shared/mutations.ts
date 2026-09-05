import { z } from "zod";
import { ageInYears, referenceNow } from "./schema.js";

/**
 * The evaluation harness's other half.
 *
 * Each mutation breaks exactly one rule from SPEC.md. The generated suite's score is the
 * fraction of these it catches with a spec-sourced FAIL. See PLAN.md § 6.
 *
 * Mutations never edit shared/schema.ts — they suppress a specific validation issue or
 * patch a specific handler behaviour at runtime. That keeps the *declared* truth pristine
 * while the *behaving* truth drifts, which is precisely the condition the tool must detect.
 */

export type MutationBehavior =
  | "skip-email-unique"
  | "skip-status-permission"
  | "drop-phone-on-save";

export interface Mutation {
  id: string;
  description: string;
  /** The requirement this mutation violates. */
  specRef: string;
  /** What kind of defect this stands in for. */
  class: string;
  /** Return true to discard a validation issue, weakening or removing the rule. */
  suppressIssue?: (issue: z.ZodIssue, input: Record<string, unknown>) => boolean;
  /** A change in handler behaviour rather than in validation. */
  behavior?: MutationBehavior;
}

const digits = (v: unknown): string => (typeof v === "string" ? v : "");

export const MUTATIONS: Mutation[] = [
  {
    id: "email-format",
    description: "Email format check removed; any non-empty string is accepted.",
    specRef: "REQ-2.3",
    class: "validation-removed",
    suppressIssue: (issue) =>
      issue.path[0] === "email" && issue.code === z.ZodIssueCode.invalid_string,
  },
  {
    id: "name-min",
    description: "Full name minimum length weakened from 2 to 0.",
    specRef: "REQ-2.1",
    class: "boundary-weakened",
    suppressIssue: (issue) =>
      issue.path[0] === "fullName" && issue.code === z.ZodIssueCode.too_small,
  },
  {
    id: "phone-length",
    description: "Phone accepts 9 digits as well as 10 (off-by-one).",
    specRef: "REQ-2.5",
    class: "off-by-one",
    suppressIssue: (issue, input) =>
      issue.path[0] === "phone" && /^[0-9]{9}$/.test(digits(input.phone)),
  },
  {
    id: "dept-conditional",
    description: "Department is no longer required for non-viewer roles.",
    specRef: "REQ-2.8",
    class: "conditional-logic",
    suppressIssue: (issue) =>
      issue.path[0] === "department" &&
      issue.code === z.ZodIssueCode.custom &&
      issue.message.includes("required"),
  },
  {
    id: "age-min",
    description: "Minimum age weakened from 18 to 16.",
    specRef: "REQ-2.9",
    class: "boundary-weakened",
    suppressIssue: (issue, input) => {
      if (issue.path[0] !== "dateOfBirth" || !issue.message.includes("at least")) {
        return false;
      }
      const dob = new Date(`${digits(input.dateOfBirth)}T00:00:00Z`);
      if (Number.isNaN(dob.getTime())) return false;
      const age = ageInYears(dob, referenceNow());
      return age >= 16;
    },
  },
  {
    id: "bio-max",
    description: "Bio maximum length weakened from 500 to 5000.",
    specRef: "REQ-2.10",
    class: "boundary-weakened",
    suppressIssue: (issue, input) =>
      issue.path[0] === "bio" &&
      issue.code === z.ZodIssueCode.too_big &&
      digits(input.bio).length <= 5000,
  },
  {
    id: "role-enum",
    description: "Role accepts arbitrary strings outside the declared enum.",
    specRef: "REQ-2.7",
    class: "enum-unenforced",
    suppressIssue: (issue) =>
      issue.path[0] === "role" && issue.code === z.ZodIssueCode.invalid_enum_value,
  },
  {
    id: "status-permission",
    description: "Role guard on account status removed; any role may change it.",
    specRef: "REQ-3.2",
    class: "authorization",
    behavior: "skip-status-permission",
  },
  {
    id: "email-unique",
    description: "Server-side email uniqueness check removed.",
    specRef: "REQ-2.4",
    class: "server-only-rule",
    behavior: "skip-email-unique",
  },
  {
    id: "phone-silent-drop",
    description: "PATCH returns 200 but never persists the phone field.",
    specRef: "REQ-4.1",
    class: "silent-data-loss",
    behavior: "drop-phone-on-save",
  },
];

const byId = new Map(MUTATIONS.map((m) => [m.id, m]));

export function getMutation(id: string): Mutation | undefined {
  return byId.get(id);
}

export function assertKnown(ids: string[]): void {
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown mutation(s): ${unknown.join(", ")}`);
  }
}

export function behaviorActive(
  active: readonly string[],
  behavior: MutationBehavior,
): boolean {
  return active.some((id) => byId.get(id)?.behavior === behavior);
}

/**
 * Apply every armed suppression to a validation result.
 *
 * Pure, and shared by the server and the browser on purpose. A mutation stands in for a
 * developer weakening a rule in the shared schema — which would weaken it on both sides.
 * Applying it server-only would let a UI test pass on client-side validation alone and
 * report a defect it never actually detected.
 */
export function filterIssues(
  issues: z.ZodIssue[],
  input: Record<string, unknown>,
  active: readonly string[],
): z.ZodIssue[] {
  if (active.length === 0) return issues;
  const armed = active
    .map((id) => byId.get(id))
    .filter((m): m is Mutation => Boolean(m?.suppressIssue));

  return issues.filter((issue) => !armed.some((m) => m.suppressIssue!(issue, input)));
}
