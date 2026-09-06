import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { Browser, BrowserContext } from "playwright";
import { loadConfig } from "../config.js";
import { newContext, resetApp, setMutations } from "../harness.js";
import { buildTools } from "./tools.js";
import type { ExploreSession } from "./tools.js";
import { validateProposals } from "./explorer.js";
import type { RequestLog } from "../exec/types.js";
import type { TestCase } from "../synth/testcase.js";

/**
 * The explorer's agent loop cannot be tested without a credential, but its hands can —
 * and the hands are where the risk is. If a tool silently fails or lets the agent off
 * the application, no amount of prompt quality saves the run.
 *
 * Requires the demo app to be running (`npm run demo`). Skips cleanly if it is not.
 */

const config = loadConfig();

type Tool = ReturnType<typeof buildTools>[number];
const call = (tools: Tool[], name: string, input: unknown) => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool "${name}" should exist`);
  return tool.run(input);
};

const appIsUp = await fetch(`${config.apiUrl}${config.testControl.mutations}`)
  .then((r) => r.ok)
  .catch(() => false);

describe("explorer tool surface", { skip: appIsUp ? false : "demo app not running" }, () => {
  let browser: Browser;
  let context: BrowserContext;
  let session: ExploreSession;
  let tools: Tool[];

  before(async () => {
    await resetApp(config, "users.basic");
    await setMutations(config, []);
    browser = await chromium.launch();
    context = await newContext(browser, config, "admin");
    const page = await context.newPage();
    const requests: RequestLog[] = [];
    page.on("request", (request) => {
      requests.push({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
      });
    });
    session = { page, config, requests, proposals: [], notes: [], actions: 0 };
    tools = buildTools(session);
  });

  after(async () => {
    await context?.close();
    await browser?.close();
    await resetApp(config, "users.basic");
  });

  it("navigates and observes the page", async () => {
    const result = await call(tools, "navigate", { path: "/users/1/edit" });
    assert.match(result, /url: .*\/users\/1\/edit/);
    assert.match(result, /Edit staff record/);
    assert.match(result, /textbox "Email"/);
  });

  it("refuses to leave the application under test", async () => {
    for (const path of ["https://example.com", "//example.com", "example.com"]) {
      const result = await call(tools, "navigate", { path });
      assert.match(result, /^FAILED/, `should refuse "${path}"`);
    }
    // Still on the page it was on.
    assert.match(session.page.url(), /\/users\/1\/edit/);
  });

  it("fills a field and sees the value it typed", async () => {
    await call(tools, "navigate", { path: "/users/1/edit" });
    const filled = await call(tools, "fill", { target: "phone", value: "0123456789" });
    assert.match(filled, /resolved by testid/);
    const seen = await call(tools, "observe", {});
    assert.match(seen, /0123456789/);
  });

  it("returns a readable failure instead of throwing on a bad target", async () => {
    const result = await call(tools, "fill", { target: "nope-not-here", value: "x" });
    assert.match(result, /^FAILED/);
  });

  it("clicks save and can confirm persistence through the API", async () => {
    await call(tools, "navigate", { path: "/users/2/edit" });
    await call(tools, "fill", { target: "fullName", value: "Explored Name" });
    const clicked = await call(tools, "click", { target: "save" });
    assert.match(clicked, /resolved by testid/);

    const record = await call(tools, "read_api", { path: "/api/users/2" });
    assert.match(record, /^200/);
    assert.match(record, /Explored Name/);
  });

  it("refuses a read_api path that is not a path", async () => {
    const result = await call(tools, "read_api", { path: "https://example.com/x" });
    assert.match(result, /^FAILED/);
  });

  it("reports data requests without document or script noise", async () => {
    const result = await call(tools, "requests", {});
    assert.match(result, /PATCH .*\/api\/users\/2/);
    assert.doesNotMatch(result, /\.tsx/);
  });

  it("records proposals and notes", async () => {
    await call(tools, "note", { observation: "the cancel button discards silently" });
    assert.equal(session.notes.length, 1);

    const proposal: TestCase = {
      id: "TC-DEMO-1",
      title: "demo",
      screen: "/users/:id/edit",
      feature: "user-profile",
      kind: "happy",
      priority: "P3",
      assertionSource: "code",
      rationale: "recorded behaviour",
      preconditions: [{ type: "reset", value: "users.basic" }],
      steps: [{ action: "goto", target: "/users/1/edit" }],
      expected: [{ assert: "visible", target: "save" }],
    };
    const result = await call(tools, "propose_case", proposal);
    assert.match(result, /proposed TC-DEMO-1/);
    assert.equal(session.proposals.length, 1);
  });

  it("counts every action for the budget report", () => {
    assert.ok(session.actions > 0);
  });
});

describe("proposal gatekeeping", () => {
  const base: TestCase = {
    id: "TC-A",
    title: "t",
    screen: "/users/:id/edit",
    feature: "f",
    kind: "negative",
    priority: "P1",
    assertionSource: "code",
    rationale: "r",
    preconditions: [{ type: "reset", value: "users.basic" }],
    steps: [{ action: "goto", target: "/users/1/edit" }],
    expected: [{ assert: "visible", target: "error-email" }],
  };
  const ctx = {
    spec: "REQ-2.3 — The email address must be valid.",
    specPath: "SPEC.md",
    existingIds: new Set(["TC-EXP-TAKEN"]),
  };

  it("namespaces ids so explorer output cannot collide", () => {
    const { candidates } = validateProposals([base], ctx);
    assert.equal(candidates[0].id, "TC-EXP-A");
  });

  it("rejects a spec claim naming a requirement that does not exist", () => {
    const { candidates, rejected } = validateProposals(
      [{ ...base, assertionSource: "spec", specRef: "REQ-9.9" }],
      ctx,
    );
    assert.equal(candidates.length, 0);
    assert.match(rejected[0], /REQ-9\.9" is not in SPEC\.md/);
  });

  it("admits a spec claim naming a real requirement", () => {
    const { candidates } = validateProposals(
      [{ ...base, assertionSource: "spec", specRef: "REQ-2.3" }],
      ctx,
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].assertionSource, "spec");
  });

  it("rejects a case that asserts nothing", () => {
    const { candidates, rejected } = validateProposals([{ ...base, expected: [] }], ctx);
    assert.equal(candidates.length, 0);
    assert.match(rejected[0], /asserts nothing/);
  });

  it("rejects duplicates, within the batch and against the corpus", () => {
    const { candidates, rejected } = validateProposals(
      [base, base, { ...base, id: "TC-EXP-TAKEN" }],
      ctx,
    );
    assert.equal(candidates.length, 1);
    assert.equal(rejected.filter((r) => /duplicate/.test(r)).length, 2);
  });
});
