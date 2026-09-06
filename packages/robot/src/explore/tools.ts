import { z } from "zod/v4";
import type { Page } from "playwright";
import type { RobotConfig } from "../config.js";
import { resolve } from "../exec/locator.js";
import { DATA_RESOURCE_TYPES } from "../exec/types.js";
import type { RequestLog } from "../exec/types.js";
import { testCaseSchema } from "../synth/testcase.js";
import type { TestCase } from "../synth/testcase.js";
import type { RobotTool } from "../llm.js";

/**
 * The explorer's hands.
 *
 * Deliberately the same semantic vocabulary the DSL uses — targets are names, never
 * selectors or coordinates — so anything the explorer can do, a compiled test case can
 * also do. A tool the executor cannot replay would let the explorer propose cases that
 * can never run.
 *
 * Every tool returns a readable string on failure rather than throwing. A thrown error
 * aborts the whole run; a returned one lets the agent notice it took a wrong turn and
 * carry on, which is most of what exploring is.
 */

export interface ExploreSession {
  page: Page;
  config: RobotConfig;
  requests: RequestLog[];
  proposals: TestCase[];
  notes: string[];
  /** Tool calls made, for the budget report. */
  actions: number;
}

const MAX_SNAPSHOT = 6000;

/**
 * Tools are declared provider-neutrally: the explorer never learns which API is on the
 * other end, and adding a vendor does not touch this file.
 */
function tool<S extends z.ZodType<unknown>>(spec: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>) => Promise<string>;
}): RobotTool {
  return spec as unknown as RobotTool;
}

async function act(
  session: ExploreSession,
  work: () => Promise<string>,
): Promise<string> {
  session.actions += 1;
  try {
    return await work();
  } catch (error) {
    return `FAILED: ${(error as Error).message.split("\n")[0]}`;
  }
}

async function describe(session: ExploreSession): Promise<string> {
  const url = session.page.url();
  const snapshot = await session.page.locator("body").ariaSnapshot();
  const body =
    snapshot.length > MAX_SNAPSHOT
      ? `${snapshot.slice(0, MAX_SNAPSHOT)}\n… (truncated)`
      : snapshot;
  return `url: ${url}\n\n${body}`;
}

export function buildTools(session: ExploreSession): RobotTool[] {
  const { config } = session;

  const observe = tool({
    name: "observe",
    description:
      "Read the current page: its URL and its accessibility tree. Call this after any " +
      "action that might change the page. This is your eyes — there are no screenshots.",
    inputSchema: z.object({}),
    run: async () => act(session, () => describe(session)),
  });

  const navigate = tool({
    name: "navigate",
    description:
      "Go to a path on the application under test, e.g. '/users/1/edit'. Paths only — " +
      "this tool cannot leave the application.",
    inputSchema: z.object({
      path: z.string().describe("A path beginning with '/'."),
    }),
    run: async ({ path }) =>
      act(session, async () => {
        // Confine the explorer to the application it was pointed at.
        if (!path.startsWith("/") || path.startsWith("//")) {
          return `FAILED: "${path}" is not a path on the application under test.`;
        }
        await session.page.goto(`${config.baseUrl}${path}`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
        return describe(session);
      }),
  });

  const fill = tool({
    name: "fill",
    description:
      "Type a value into a field, replacing what is there. Use the field's test id or " +
      "its visible label. Pass an empty string to clear it.",
    inputSchema: z.object({
      target: z.string(),
      value: z.string(),
    }),
    run: async ({ target, value }) =>
      act(session, async () => {
        const { locator, strategy } = await resolve(session.page, target);
        await locator.fill(value);
        return `filled "${target}" (resolved by ${strategy})`;
      }),
  });

  const click = tool({
    name: "click",
    description:
      "Click a button, link or control, then wait for the page to settle. Returns the " +
      "page as it stands afterwards.",
    inputSchema: z.object({ target: z.string() }),
    run: async ({ target }) =>
      act(session, async () => {
        const { locator, strategy } = await resolve(session.page, target);
        await locator.click();
        await session.page
          .waitForLoadState("networkidle", { timeout: 10000 })
          .catch(() => {});
        return `clicked "${target}" (resolved by ${strategy})\n\n${await describe(session)}`;
      }),
  });

  const select = tool({
    name: "select",
    description: "Choose an option in a dropdown by its value.",
    inputSchema: z.object({ target: z.string(), value: z.string() }),
    run: async ({ target, value }) =>
      act(session, async () => {
        const { locator } = await resolve(session.page, target);
        await locator.selectOption(value);
        return `selected "${value}" in "${target}"`;
      }),
  });

  const setCheckbox = tool({
    name: "set_checkbox",
    description: "Tick or untick a checkbox.",
    inputSchema: z.object({ target: z.string(), checked: z.boolean() }),
    run: async ({ target, checked }) =>
      act(session, async () => {
        const { locator } = await resolve(session.page, target);
        if (checked) await locator.check();
        else await locator.uncheck();
        return `${checked ? "checked" : "unchecked"} "${target}"`;
      }),
  });

  const requests = tool({
    name: "requests",
    description:
      "List the data requests the page has sent so far (documents, scripts and styles " +
      "omitted). Use this to find out whether an action actually reached the server.",
    inputSchema: z.object({}),
    run: async () =>
      act(session, async () => {
        const data = session.requests.filter(
          (request) =>
            !request.resourceType || DATA_RESOURCE_TYPES.has(request.resourceType),
        );
        if (data.length === 0) return "no data requests yet";
        return data.map((r) => `${r.method} ${r.url}`).join("\n");
      }),
  });

  const readApi = tool({
    name: "read_api",
    description:
      "GET a path on the application's API and return the JSON, authenticated as the " +
      "current user. Use it to check whether a save actually persisted — the form only " +
      "shows you what you typed.",
    inputSchema: z.object({
      path: z.string().describe("An API path beginning with '/', e.g. '/api/users/1'."),
    }),
    run: async ({ path }) =>
      act(session, async () => {
        if (!path.startsWith("/") || path.startsWith("//")) {
          return `FAILED: "${path}" is not a path on the application under test.`;
        }
        const token = await session.page.evaluate(
          (key: string) => window.localStorage.getItem(key),
          config.auth.storageKey,
        );
        const response = await fetch(`${config.apiUrl}${path}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const text = await response.text();
        return `${response.status}\n${text.slice(0, 2000)}`;
      }),
  });

  const note = tool({
    name: "note",
    description:
      "Record an observation that is worth a human's attention but is not a test case — " +
      "a control that does nothing, a confusing message, a rule you could not exercise.",
    inputSchema: z.object({ observation: z.string() }),
    run: async ({ observation }) =>
      act(session, async () => {
        session.notes.push(observation);
        return "noted";
      }),
  });

  const proposeCase = tool({
    name: "propose_case",
    description:
      "Propose a regression test case for something you have actually observed. This is " +
      "your only output — everything else you do is in service of this. The case must " +
      "stand alone: it will be replayed from a fresh reset, in a fresh browser, with no " +
      "memory of anything you did while exploring.",
    inputSchema: testCaseSchema,
    run: async (testCase) =>
      act(session, async () => {
        session.proposals.push(testCase);
        return `proposed ${testCase.id} (${testCase.assertionSource}-sourced). Keep exploring.`;
      }),
  });

  return [
    observe,
    navigate,
    fill,
    click,
    select,
    setCheckbox,
    requests,
    readApi,
    note,
    proposeCase,
  ];
}
