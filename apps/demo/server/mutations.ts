import type { z } from "zod";
import {
  MUTATIONS,
  assertKnown,
  behaviorActive,
  filterIssues as filterIssuesPure,
} from "../shared/mutations.js";
import type { MutationBehavior } from "../shared/mutations.js";

export { MUTATIONS };
export type { MutationBehavior };

/** The mutations currently armed. Empty in normal operation. */
let active: string[] = [];

export function setActiveMutations(ids: string[]): string[] {
  assertKnown(ids);
  active = [...ids];
  return [...active];
}

export function getActiveMutations(): string[] {
  return [...active];
}

export function hasBehavior(behavior: MutationBehavior): boolean {
  return behaviorActive(active, behavior);
}

export function filterIssues(
  issues: z.ZodIssue[],
  input: Record<string, unknown>,
): z.ZodIssue[] {
  return filterIssuesPure(issues, input, active);
}
