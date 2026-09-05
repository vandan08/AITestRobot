import { filterIssues } from "../../shared/mutations";

/**
 * The browser half of the mutation harness.
 *
 * A mutation models a developer weakening a rule in the shared schema, so it has to be
 * visible on both sides. Without this, a UI test would pass on client-side validation
 * alone while the server rule was gone — the suite would look like it caught a defect it
 * never detected.
 *
 * Present only in the demo target; a real application under test has no such hook.
 */
let active: string[] = [];

export async function loadActiveMutations(): Promise<void> {
  try {
    const response = await fetch("/__test__/mutations");
    const body = (await response.json()) as { active?: string[] };
    active = body.active ?? [];
  } catch {
    active = [];
  }
}

export { filterIssues };

export function activeMutations(): string[] {
  return active;
}
