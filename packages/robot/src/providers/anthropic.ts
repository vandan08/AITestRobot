import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod/v4";
import {
  LLMError,
  NO_USAGE,
  addUsage,
} from "./base.js";
import type {
  JsonRequest,
  Pricing,
  JsonResult,
  Provider,
  ToolRequest,
  ToolResult,
  Usage,
} from "./base.js";

/**
 * Anthropic.
 *
 * The incumbent, and the one the prompts were written against. It is also the only
 * provider whose SDK can find a credential this tool cannot see — `ant auth login` sets
 * no environment variable — which is why it stays the fallback when nothing is keyed.
 */

export const name = "anthropic";
export const label = "Anthropic Claude";
export const envKeys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
export const defaultModel = "claude-opus-5";
export const authHint = "set ANTHROPIC_API_KEY, or run `ant auth login`";

/**
 * Rough published rates for the opus class, for report estimates only. Haiku- and
 * sonnet-class models are cheaper; override the model and this becomes an overestimate
 * rather than a wrong decision, since nothing reads it.
 */
export function pricingFor(_model: string): Pricing {
  return { inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5 };
}

function usageOf(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
}): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Turn an SDK failure into something the reader can act on.
 *
 * The 401 case earns its own handling: an inherited ANTHROPIC_AUTH_TOKEN from a
 * surrounding agent harness is picked up ahead of anything else, and "Invalid bearer
 * token" gives no clue why a key you just exported is being ignored.
 */
export function explain(error: unknown): string {
  const status = (error as { status?: number })?.status;
  const message = (error as Error)?.message ?? String(error);

  if (status === 401 || status === 403) {
    const lines = [
      "Anthropic rejected the credentials.",
      "",
      "The SDK resolves credentials in this order, first match wins:",
      "  ANTHROPIC_API_KEY -> ANTHROPIC_AUTH_TOKEN -> an `ant auth login` profile",
      "",
    ];
    if (process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
      lines.push(
        "ANTHROPIC_AUTH_TOKEN is set here and ANTHROPIC_API_KEY is not, so the token is",
        "being used. If it belongs to a surrounding agent or proxy rather than to you, it",
        "will not authenticate.",
        "",
      );
    }
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    const redirected =
      baseUrl && !/^https:\/\/api\.anthropic\.com\/?$/.test(baseUrl.trim());
    if (redirected) {
      lines.push(
        `ANTHROPIC_BASE_URL points at ${baseUrl}, so requests are not reaching the API`,
        "directly.",
        "",
      );
    }
    lines.push(
      "Fix: run this in a shell with your own key:",
      "",
      redirected
        ? "  unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL"
        : "  unset ANTHROPIC_AUTH_TOKEN",
      "  export ANTHROPIC_API_KEY=sk-ant-...",
      "",
      "Or authenticate once with `ant auth login`. To use a different vendor instead,",
      "set GEMINI_API_KEY and unset the Anthropic variables.",
    );
    return lines.join("\n");
  }

  if (status === 429) return `Anthropic rate limited the request.\n${message}`;
  if (status !== undefined && status >= 500) {
    return `Anthropic returned ${status}. This is usually transient.\n${message}`;
  }
  return message;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new LLMError(explain(error));
  }
}

export async function askJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
  const client = new Anthropic();
  const response = await guarded(() =>
    client.messages.parse({
      model: request.model,
      max_tokens: request.maxTokens,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: request.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: request.user }],
      output_config: {
        format: zodOutputFormat(request.schema as unknown as z.ZodType),
      },
    }),
  );

  return {
    value: (response.parsed_output as T | null) ?? null,
    usage: usageOf(response.usage),
  };
}

export async function runTools(request: ToolRequest): Promise<ToolResult> {
  const client = new Anthropic();

  const runner = client.beta.messages.toolRunner({
    model: request.model,
    max_tokens: request.maxTokens,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: request.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: request.user }],
    tools: request.tools.map((tool) =>
      betaZodTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as z.ZodType,
        run: tool.run,
      }),
    ),
    max_iterations: request.maxIterations,
  });

  let usage = NO_USAGE;
  let turns = 0;
  let stopReason: ToolResult["stopReason"] = "completed";

  await guarded(async () => {
    for await (const message of runner) {
      turns += 1;
      usage = addUsage(usage, usageOf(message.usage));
      if (request.onTurn && !request.onTurn(usage)) {
        stopReason = "budget";
        break;
      }
      if (turns >= request.maxIterations) {
        stopReason = "max-iterations";
        break;
      }
    }
  });

  return { turns, usage, stopReason };
}

export const provider: Provider = {
  name,
  label,
  envKeys,
  defaultModel,
  authHint,
  pricingFor,
  askJson,
  runTools,
};
