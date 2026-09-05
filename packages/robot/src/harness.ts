import type { Browser, BrowserContext } from "playwright";
import type { RobotConfig } from "./config.js";

/**
 * Establishing known state. The unglamorous half that decides whether any of this is
 * reproducible — see PLAN.md section 9.
 */

async function post(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${url} -> ${response.status} ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function resetApp(
  config: RobotConfig,
  fixture = "users.basic",
): Promise<void> {
  await post(`${config.apiUrl}${config.testControl.reset}`, { fixture });
}

export async function setMutations(
  config: RobotConfig,
  active: string[],
): Promise<string[]> {
  const result = (await post(`${config.apiUrl}${config.testControl.mutations}`, {
    active,
  })) as { active: string[] };
  return result.active;
}

export async function listMutations(config: RobotConfig): Promise<{
  active: string[];
  available: Array<{ id: string; description: string; specRef: string; class: string }>;
}> {
  const response = await fetch(
    `${config.apiUrl}${config.testControl.mutations}`,
  );
  return (await response.json()) as never;
}

/** A token for a named role, minted through the API — never by driving the login form. */
export async function tokenFor(config: RobotConfig, as: string): Promise<string> {
  const id = config.auth.users[as];
  if (id === undefined) {
    throw new Error(
      `Unknown auth role "${as}". Known: ${Object.keys(config.auth.users).join(", ")}`,
    );
  }
  const result = (await post(`${config.apiUrl}${config.auth.tokenEndpoint}`, {
    id,
  })) as { token: string };
  return result.token;
}

/**
 * A fresh, isolated context, pre-authenticated by injected storage state.
 * Driving the sign-in form 400 times is how suites get slow and flaky.
 */
export async function newContext(
  browser: Browser,
  config: RobotConfig,
  as?: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: config.baseUrl });

  if (as) {
    const token = await tokenFor(config, as);
    await context.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
      },
      { key: config.auth.storageKey, value: token },
    );
  }

  return context;
}

/** Fill `:param` placeholders using the configured sample URLs. */
export function concreteUrl(config: RobotConfig, route: string): string {
  if (!route.includes(":")) return route;
  return config.routeSamples[route] ?? route.replace(/:[A-Za-z0-9_]+/g, "1");
}
