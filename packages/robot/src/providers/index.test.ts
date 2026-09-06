import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LLMError } from "./base.js";
import { available, explainChoice, keyed, resolve } from "./index.js";
import { schemaFor, thinkingBudget } from "./gemini.js";
import { z } from "zod/v4";

/**
 * Provider selection is pure and reads only the environment, so it is the one part of
 * the model plumbing that can be tested exhaustively without a key. Given that getting
 * it wrong means quietly billing the wrong vendor, it is worth doing.
 */

const VARS = [
  "ROBOT_PROVIDER",
  "ROBOT_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((key) => [key, process.env[key]]));
  for (const key of VARS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("provider selection", () => {
  it("falls back to Anthropic when nothing is keyed", () => {
    assert.equal(resolve().name, "anthropic");
    assert.deepEqual(available(), []);
    assert.match(explainChoice(), /nothing keyed/);
  });

  it("uses the one provider that has a key", () => {
    process.env.GEMINI_API_KEY = "x";
    assert.equal(resolve().name, "gemini");

    delete process.env.GEMINI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "x";
    assert.equal(resolve().name, "anthropic");
  });

  it("reads every alias for a provider's key", () => {
    process.env.GOOGLE_API_KEY = "x";
    assert.ok(keyed("gemini"));
    delete process.env.GOOGLE_API_KEY;

    process.env.ANTHROPIC_AUTH_TOKEN = "x";
    assert.ok(keyed("anthropic"));
  });

  it("ignores a variable that is set but blank", () => {
    process.env.GEMINI_API_KEY = "   ";
    assert.equal(keyed("gemini"), false);
    assert.equal(resolve().name, "anthropic");
  });

  it("prefers the newly added key when two are visible", () => {
    // The way this happens in practice is someone already on Anthropic pasting in a
    // Gemini key to try it. A rule that answered by changing nothing reads as broken.
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.GEMINI_API_KEY = "y";
    assert.equal(resolve().name, "gemini");
    assert.deepEqual(available(), ["gemini", "anthropic"]);
  });

  it("lets ROBOT_PROVIDER override a visible key", () => {
    process.env.GEMINI_API_KEY = "y";
    process.env.ROBOT_PROVIDER = "anthropic";
    assert.equal(resolve().name, "anthropic");
    assert.match(explainChoice(), /ROBOT_PROVIDER=anthropic/);
  });

  it("refuses an unknown ROBOT_PROVIDER rather than falling through", () => {
    // A typo that quietly bills the wrong vendor is worse than a run that stops.
    process.env.ROBOT_PROVIDER = "gemeni";
    assert.throws(() => resolve(), LLMError);
  });

  it("accepts a provider name in any case", () => {
    process.env.ROBOT_PROVIDER = "  GEMINI ";
    assert.equal(resolve().name, "gemini");
  });
});

describe("gemini specifics", () => {
  it("keeps the thinking budget inside the model's accepted range", () => {
    assert.equal(thinkingBudget(100), 128, "clamps up to the minimum");
    assert.equal(thinkingBudget(8000), 4000, "half the ceiling");
    assert.equal(thinkingBudget(1e6), 24576, "clamps down to the maximum");
  });

  it("never spends the whole ceiling on thinking", () => {
    for (const ceiling of [4000, 8000, 16000, 32000]) {
      assert.ok(
        thinkingBudget(ceiling) < ceiling,
        `${ceiling} would leave nothing for the answer`,
      );
    }
  });

  it("strips schema keywords Gemini does not accept", () => {
    const schema = z.toJSONSchema(
      z.object({ a: z.string(), b: z.object({ c: z.number() }) }),
    );
    const cleaned = JSON.stringify(schemaFor(schema));
    assert.doesNotMatch(cleaned, /additionalProperties/);
    assert.doesNotMatch(cleaned, /\$schema/);
    // and keeps everything that matters
    assert.match(cleaned, /"required"/);
    assert.match(cleaned, /"properties"/);
    assert.match(cleaned, /"c"/);
  });
});
