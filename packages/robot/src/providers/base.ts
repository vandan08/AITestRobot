import type { z } from "zod/v4";

/**
 * What a provider has to be.
 *
 * AITestRobot asks a model exactly two kinds of question, and every stage is one of them:
 *
 *   askJson   — here is a schema, fill it in. Used by divergence, synth and adjudicate.
 *   runTools  — here are some hands, go and use them. Used by the explorer.
 *
 * Two shapes is a small enough contract that more than one vendor can honestly implement
 * it, which is why this package exists rather than an SDK being wired straight into each
 * stage. Anything a provider cannot do it must refuse loudly — a stage that silently
 * degrades would be worse than one that stops.
 */

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from a prompt cache, where the provider reports them. */
  cachedInputTokens: number;
}

export const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}

/** Per-million-token prices, used only for the cost estimates printed in reports. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
}

export interface JsonRequest<T> {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}

export interface JsonResult<T> {
  /** Null when the model produced nothing that satisfied the schema. */
  value: T | null;
  usage: Usage;
}

/**
 * A tool, described once in provider-neutral terms.
 *
 * Deliberately the same shape whichever vendor ends up running it: the explorer builds
 * these against a Playwright page and never learns which API is on the other end.
 */
export interface RobotTool {
  name: string;
  description: string;
  inputSchema: z.ZodType<unknown>;
  /**
   * `any` on purpose. This is a heterogeneous list of individually-typed handlers, which
   * TypeScript cannot express without existential types — every alternative (`unknown`,
   * `never`) breaks either the caller or the implementer on variance. Each tool's own
   * declaration is typed against its schema at the point of definition, which is where
   * the safety actually matters, and `invokeTool` validates against that schema before
   * calling anything.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (input: any) => Promise<string>;
}

export interface ToolRequest {
  model: string;
  system: string;
  user: string;
  tools: RobotTool[];
  maxTokens: number;
  maxIterations: number;
  /**
   * Called after each turn with the running total. Return false to stop.
   * A wandering agent is the expensive failure mode, so the caller keeps the brake.
   */
  onTurn?: (usage: Usage) => boolean;
}

export interface ToolResult {
  turns: number;
  usage: Usage;
  /** Why the loop ended, for the report. */
  stopReason: "completed" | "budget" | "max-iterations";
}

export interface Provider {
  readonly name: string;
  readonly label: string;
  /** Environment variables that mean "this one is configured". */
  readonly envKeys: readonly string[];
  readonly defaultModel: string;
  readonly authHint: string;
  readonly pricing: Pricing;
  askJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>>;
  runTools(request: ToolRequest): Promise<ToolResult>;
}

export function estimateCost(usage: Usage, pricing: Pricing): number {
  return (
    (usage.inputTokens / 1e6) * pricing.inputPerMTok +
    (usage.outputTokens / 1e6) * pricing.outputPerMTok +
    (usage.cachedInputTokens / 1e6) * pricing.cachedInputPerMTok
  );
}

/** Run one tool by name, turning any throw into text the model can recover from. */
export async function invokeTool(
  tools: RobotTool[],
  name: string,
  args: unknown,
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return `FAILED: there is no tool called "${name}".`;
  }
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return `FAILED: those arguments do not fit ${name}: ${parsed.error.message}`;
  }
  try {
    return await tool.run(parsed.data);
  } catch (error) {
    return `FAILED: ${(error as Error).message.split("\n")[0]}`;
  }
}
