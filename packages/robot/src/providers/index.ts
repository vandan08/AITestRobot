import { LLMError } from "./base.js";
import type { Provider } from "./base.js";
import { provider as anthropic } from "./anthropic.js";
import { provider as gemini } from "./gemini.js";

/**
 * Which provider this run talks to, and how that gets decided.
 *
 * The rule is meant to survive being read once and remembered:
 *
 * 1. `ROBOT_PROVIDER` if it is set. An unknown name is an error rather than a silent
 *    fall-through — a typo'd provider that quietly bills the wrong vendor is worse than
 *    a run that stops.
 * 2. Otherwise the first provider in `ORDER` whose key is visible. With one key
 *    configured — the ordinary case — this is just "the one you configured", and
 *    switching is deleting one variable and setting another.
 * 3. Otherwise Anthropic, the only one whose SDK can find a credential this tool cannot
 *    see: `ant auth login` sets no environment variable.
 *
 * `ORDER` matters only when two keys are visible at once, and it puts Gemini ahead of the
 * incumbent deliberately. Adding a key is a deliberate act; leaving one behind is not.
 * The way this happens in practice is someone already running on Anthropic pasting in a
 * GEMINI_API_KEY to try it, and a rule that answered that by changing nothing would read
 * as broken. The stale key is the one that should lose.
 *
 * Whichever wins, `robot providers` says which was picked and what else was visible, so
 * the answer is one `ROBOT_PROVIDER=` away and never a mystery.
 *
 * Selection lives here. What to send — model, ceiling — lives in `llm.ts`, which is what
 * the rest of the tool imports.
 */

export const REGISTRY: Record<string, Provider> = {
  [anthropic.name]: anthropic,
  [gemini.name]: gemini,
};

/** Tie-break order, and the order `robot providers` lists them in. */
export const ORDER = [gemini.name, anthropic.name] as const;

export const DEFAULT = anthropic.name;

/** Whether a credential for this provider is visible in the environment. */
export function keyed(providerName: string): boolean {
  const provider = REGISTRY[providerName];
  if (!provider) return false;
  return provider.envKeys.some((key) => (process.env[key] ?? "").trim() !== "");
}

/** Every provider with a visible key, in ORDER. Usually one, sometimes none. */
export function available(): string[] {
  return ORDER.filter((providerName) => keyed(providerName));
}

/** The provider this run will use. See the rule at the top of the file. */
export function resolve(): Provider {
  const chosen = (process.env.ROBOT_PROVIDER ?? "").trim().toLowerCase();
  if (chosen) {
    const provider = REGISTRY[chosen];
    if (!provider) {
      throw new LLMError(
        `unknown ROBOT_PROVIDER "${chosen}" — it must be one of: ${ORDER.join(", ")}`,
      );
    }
    return provider;
  }

  const [first] = available();
  return first ? REGISTRY[first] : REGISTRY[DEFAULT];
}

/** Why the chosen provider was chosen, for the CLI to print. */
export function explainChoice(): string {
  const chosen = (process.env.ROBOT_PROVIDER ?? "").trim().toLowerCase();
  if (chosen) return `ROBOT_PROVIDER=${chosen}`;
  const keys = available();
  if (keys.length === 0) return `nothing keyed — falling back to ${DEFAULT}`;
  if (keys.length === 1) return `the only provider with a key`;
  return `first keyed provider in order (${ORDER.join(", ")})`;
}

export { LLMError } from "./base.js";
export type { Provider, RobotTool, Usage } from "./base.js";
export { estimateCost, NO_USAGE, addUsage } from "./base.js";
