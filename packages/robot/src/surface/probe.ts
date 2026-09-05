import { chromium } from "playwright";
import type { RobotConfig } from "../config.js";
import { concreteUrl, newContext, resetApp } from "../harness.js";
import type { ProbedControl, ProbedScreen, SurfaceRoute } from "../types.js";

/**
 * Static analysis knows the rules; only a browser knows what is actually rendered.
 *
 * The snapshot captured here is Playwright's accessibility tree, not a screenshot.
 * That choice is load-bearing: it is 10-100x cheaper in tokens and gives the model
 * stable named handles instead of pixel coordinates to guess at.
 */
export async function probeScreens(
  config: RobotConfig,
  routes: SurfaceRoute[],
): Promise<ProbedScreen[]> {
  await resetApp(config);

  const browser = await chromium.launch();
  const context = await newContext(browser, config, config.probeAs);
  const page = await context.newPage();
  const screens: ProbedScreen[] = [];

  try {
    for (const route of routes) {
      // Redirect-only routes carry no surface of their own.
      if (route.path === "/" || route.component === "Navigate") continue;

      const target = concreteUrl(config, route.path);
      const screen: ProbedScreen = {
        route: route.path,
        url: target,
        reachable: false,
        controls: [],
        snapshot: "",
      };

      try {
        await page.goto(`${config.baseUrl}${target}`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
        screen.reachable = true;
        screen.snapshot = await page.locator("body").ariaSnapshot();
        screen.controls = await readControls(page);
      } catch (error) {
        screen.error = (error as Error).message.split("\n")[0];
      }

      screens.push(screen);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return screens;
}

async function readControls(page: import("playwright").Page): Promise<ProbedControl[]> {
  const raw = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("input, select, textarea, button, a[href]"),
    );

    return nodes.map((node) => {
      const element = node as HTMLElement;
      const id = element.getAttribute("id");
      const label = id
        ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim()
        : undefined;

      const control: Record<string, unknown> = {
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") ?? undefined,
        testId: element.getAttribute("data-testid") ?? undefined,
        label: label || undefined,
        name: element.textContent?.trim().slice(0, 40) || undefined,
        disabled: (element as HTMLInputElement).disabled || undefined,
        // Scopes reconciliation to controls that actually submit data.
        inForm: Boolean(element.closest("form")),
      };

      if (element.tagName.toLowerCase() === "select") {
        control.options = Array.from((element as HTMLSelectElement).options).map(
          (option) => option.value,
        );
      }
      return control;
    });
  });

  return raw as unknown as ProbedControl[];
}
