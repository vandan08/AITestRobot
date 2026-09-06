import type { z } from "zod/v4";
import { resolve } from "./providers/index.js";
import { estimateCost as costOf } from "./providers/base.js";
import type { RobotTool, ToolResult, Usage } from "./providers/base.js";

/**
 * What to send. Which vendor to send it to is decided in `providers/`.
 *
 * Every stage goes through this module, so no stage knows or cares which API is on the
 * other end — which is the only reason a second provider was a day's work rather than a
 * rewrite of four call sites.
 */

export { LLMError } from "./providers/base.js";
export type { RobotTool, Usage } from "./providers/base.js";
export { NO_USAGE, addUsage } from "./providers/base.js";

/** The model this run uses: ROBOT_MODEL if set, else the provider's default. */
export function model(): string {
  const override = (process.env.ROBOT_MODEL ?? "").trim();
  return override || resolve().defaultModel;
}

/** Human-readable "Anthropic Claude / claude-opus-5", for report headers. */
export function describeModel(): string {
  return `${resolve().label} / ${model()}`;
}

/** Cost of some usage, priced by whichever provider is in use. Always an estimate. */
export function estimateCost(usage: Usage): number {
  return costOf(usage, resolve().pricing);
}

/** Ask for one object matching a schema. Null when nothing satisfied it. */
export async function askJson<T>(request: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}): Promise<{ value: T | null; usage: Usage }> {
  const provider = resolve();
  return provider.askJson({
    model: model(),
    system: request.system,
    user: request.user,
    schema: request.schema,
    maxTokens: request.maxTokens,
  });
}

/** Hand the model some tools and let it work. Used only by the explorer. */
export async function runTools(request: {
  system: string;
  user: string;
  tools: RobotTool[];
  maxTokens: number;
  maxIterations: number;
  onTurn?: (usage: Usage) => boolean;
}): Promise<ToolResult> {
  const provider = resolve();
  return provider.runTools({
    model: model(),
    system: request.system,
    user: request.user,
    tools: request.tools,
    maxTokens: request.maxTokens,
    maxIterations: request.maxIterations,
    onTurn: request.onTurn,
  });
}
