import type { Locator, Page } from "playwright";

/**
 * Targets in the DSL are semantic names, never CSS selectors and never coordinates.
 * The compiler resolves each through a fixed chain and records which link won, so a
 * target that quietly slides from testid to role is visible as drift rather than
 * showing up later as an inexplicable flake.
 */

export type Strategy = "testid" | "label" | "role" | "text";

export interface Resolved {
  locator: Locator;
  strategy: Strategy;
}

export class LocatorError extends Error {
  constructor(public target: string) {
    super(
      `Could not resolve "${target}" by test id, label, role or text. ` +
        `The target does not exist, or it is not addressable.`,
    );
    this.name = "LocatorError";
  }
}

async function firstVisible(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0;
}

export async function resolve(page: Page, target: string): Promise<Resolved> {
  const byTestId = page.getByTestId(target);
  if (await firstVisible(byTestId)) {
    return { locator: byTestId.first(), strategy: "testid" };
  }

  const byLabel = page.getByLabel(target, { exact: false });
  if (await firstVisible(byLabel)) {
    return { locator: byLabel.first(), strategy: "label" };
  }

  for (const role of ["button", "link", "textbox", "combobox", "checkbox"] as const) {
    const byRole = page.getByRole(role, { name: target, exact: false });
    if (await firstVisible(byRole)) {
      return { locator: byRole.first(), strategy: "role" };
    }
  }

  const byText = page.getByText(target, { exact: false });
  if (await firstVisible(byText)) {
    return { locator: byText.first(), strategy: "text" };
  }

  throw new LocatorError(target);
}
