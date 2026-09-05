import type { Page } from "playwright";
import type { RobotConfig } from "../config.js";
import type { Expectation, Step } from "../synth/testcase.js";
import { LocatorError, resolve } from "./locator.js";
import type { Strategy } from "./locator.js";
import type { RequestLog } from "./types.js";

/** Raised when a spec-sourced expectation is violated. */
export class AssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionFailure";
  }
}

export interface StepContext {
  page: Page;
  config: RobotConfig;
  requests: RequestLog[];
  strategies: Record<string, Strategy>;
}

export async function runStep(step: Step, ctx: StepContext): Promise<void> {
  const { page } = ctx;

  if (step.action === "goto") {
    const target = step.target ?? step.value ?? "/";
    await page.goto(`${ctx.config.baseUrl}${target}`, {
      waitUntil: "networkidle",
      timeout: 15000,
    });
    return;
  }

  const { locator, strategy } = await resolve(page, step.target!);
  ctx.strategies[step.target!] = strategy;

  switch (step.action) {
    case "fill":
      await locator.fill(step.value ?? "");
      break;
    case "select":
      await locator.selectOption(step.value ?? "");
      break;
    case "check":
      await locator.check();
      break;
    case "uncheck":
      await locator.uncheck();
      break;
    case "click":
      await locator.click();
      // Let any request the click triggered settle before we assert on it.
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      break;
    case "waitFor":
      await locator.waitFor({ state: "visible", timeout: 10000 });
      break;
    default:
      throw new Error(`Unknown action: ${(step as Step).action}`);
  }
}

/**
 * Assertions retry until a deadline rather than checking once.
 *
 * A one-shot check races every asynchronous render in the application and reports the
 * loss as a defect. That is the single largest source of false failures in generated
 * suites, and it is indistinguishable from a real bug in the report — so it is worth
 * paying for here rather than triaging later.
 */
export async function checkExpectation(
  expectation: Expectation,
  ctx: StepContext,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: Error | undefined;

  for (;;) {
    try {
      await checkExpectationOnce(expectation, ctx);
      return;
    } catch (error) {
      last = error as Error;
      // A malformed case or an unknown assertion will never come good by waiting.
      if (!(error instanceof AssertionFailure) && !(error instanceof LocatorError)) {
        throw error;
      }
      if (Date.now() >= deadline) throw last;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

async function checkExpectationOnce(
  expectation: Expectation,
  ctx: StepContext,
): Promise<void> {
  const { page } = ctx;

  switch (expectation.assert) {
    case "url": {
      const actual = new URL(page.url()).pathname;
      const wanted = expectation.value ?? expectation.match ?? "";
      if (!actual.includes(wanted)) {
        throw new AssertionFailure(`url is "${actual}", expected to contain "${wanted}"`);
      }
      return;
    }

    case "apiCalled":
    case "apiNotCalled": {
      const wanted = (expectation.target ?? expectation.match ?? "").trim();
      const [method, path] = wanted.includes(" ")
        ? wanted.split(/\s+/, 2)
        : ["", wanted];
      const seen = ctx.requests.some(
        (request) =>
          (!method || request.method.toUpperCase() === method.toUpperCase()) &&
          new URL(request.url).pathname.includes(path),
      );
      if (expectation.assert === "apiCalled" && !seen) {
        throw new AssertionFailure(`no request matched "${wanted}"`);
      }
      if (expectation.assert === "apiNotCalled" && seen) {
        throw new AssertionFailure(
          `a request matched "${wanted}" but none should have been sent`,
        );
      }
      return;
    }

    case "persisted": {
      await assertPersisted(expectation, ctx);
      return;
    }

    default:
      break;
  }

  // Everything below addresses a specific element.
  //
  // An element the expectation requires but that is not on the page is a violated
  // expectation, not an unrunnable test. Only a locator failure during a *step* means
  // the case could not proceed — that stays BLOCKED. Conflating the two hides real
  // defects behind an infrastructure-sounding verdict.
  let resolved;
  try {
    resolved = await resolve(page, expectation.target!);
  } catch (error) {
    if (error instanceof LocatorError) {
      // Absent satisfies "hidden".
      if (expectation.assert === "hidden") return;
      throw new AssertionFailure(
        `"${expectation.target}" is not present on the page, but "${expectation.assert}" requires it`,
      );
    }
    throw error;
  }

  const { locator, strategy } = resolved;
  ctx.strategies[expectation.target!] = strategy;

  switch (expectation.assert) {
    case "visible":
      if (!(await locator.isVisible())) {
        throw new AssertionFailure(`"${expectation.target}" is not visible`);
      }
      break;

    case "hidden":
      if (await locator.isVisible()) {
        throw new AssertionFailure(`"${expectation.target}" is visible but should not be`);
      }
      break;

    case "text": {
      const actual = (await locator.textContent())?.trim() ?? "";
      const wanted = expectation.match ?? expectation.value ?? "";
      if (!actual.toLowerCase().includes(wanted.toLowerCase())) {
        throw new AssertionFailure(
          `"${expectation.target}" reads "${actual}", expected to contain "${wanted}"`,
        );
      }
      break;
    }

    case "value": {
      const actual = await locator.inputValue();
      const wanted = expectation.value ?? "";
      if (actual !== wanted) {
        throw new AssertionFailure(
          `"${expectation.target}" holds "${actual}", expected "${wanted}"`,
        );
      }
      break;
    }

    case "enabled":
      if (!(await locator.isEnabled())) {
        throw new AssertionFailure(`"${expectation.target}" is disabled`);
      }
      break;

    case "disabled":
      if (await locator.isEnabled()) {
        throw new AssertionFailure(
          `"${expectation.target}" is operable but should be disabled`,
        );
      }
      break;

    case "count": {
      const actual = await locator.count();
      const wanted = Number(expectation.value ?? expectation.match ?? 0);
      if (actual !== wanted) {
        throw new AssertionFailure(
          `"${expectation.target}" matched ${actual} elements, expected ${wanted}`,
        );
      }
      break;
    }

    default:
      throw new Error(`Unknown assertion: ${expectation.assert}`);
  }
}

/**
 * Re-read the record through the API and confirm the value actually landed.
 *
 * This is the assertion that catches "200 OK but nothing saved" — a class of defect the
 * interface cannot reveal, because the interface is showing you what you just typed.
 */
async function assertPersisted(
  expectation: Expectation,
  ctx: StepContext,
): Promise<void> {
  const pathname = new URL(ctx.page.url()).pathname;
  const mapping = ctx.config.persistence.find((entry) =>
    new RegExp(`^${entry.route.replace(/:[A-Za-z0-9_]+/g, "([^/]+)")}$`).test(pathname),
  );
  if (!mapping) {
    throw new Error(
      `No persistence mapping for "${pathname}". Add one to robot.config.json.`,
    );
  }

  const params =
    pathname.match(
      new RegExp(`^${mapping.route.replace(/:[A-Za-z0-9_]+/g, "([^/]+)")}$`),
    ) ?? [];
  let apiPath = mapping.api;
  let index = 1;
  apiPath = apiPath.replace(/:[A-Za-z0-9_]+/g, () => params[index++] ?? "");

  const token = await ctx.page.evaluate(
    (key: string) => window.localStorage.getItem(key),
    ctx.config.auth.storageKey,
  );

  const response = await fetch(`${ctx.config.apiUrl}${apiPath}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new AssertionFailure(
      `could not re-read ${apiPath} to verify persistence (${response.status})`,
    );
  }

  const record = (await response.json()) as Record<string, unknown>;
  const field = expectation.target ?? "";
  const actual = record[field] === undefined ? "" : String(record[field]);
  const wanted = expectation.value ?? expectation.match ?? "";

  if (actual !== wanted) {
    throw new AssertionFailure(
      `"${field}" was saved as "${actual}" but should be "${wanted}" ` +
        `(the request may have returned 200 without persisting)`,
    );
  }
}
