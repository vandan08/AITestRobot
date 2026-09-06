import { GoogleGenAI } from "@google/genai";
import type { Content, GenerateContentResponse, Part } from "@google/genai";
import { z } from "zod/v4";
import { LLMError, NO_USAGE, addUsage, invokeTool } from "./base.js";
import type {
  JsonRequest,
  JsonResult,
  Provider,
  ToolRequest,
  ToolResult,
  Usage,
} from "./base.js";

/**
 * Google Gemini.
 *
 * Four things differ from the Anthropic shape and are worth knowing before switching a
 * run over.
 *
 * **Thinking is spent out of the output ceiling.** A fixed thinking budget and a fixed
 * `maxOutputTokens` can contradict each other — ask for 16k of thinking inside an 8k
 * ceiling and the model stops before writing a single field. So the budget is a fraction
 * of the ceiling, which cannot starve the answer whatever the caller passes.
 *
 * **The thinking knob is model-dependent.** 2.5 takes a token budget, 3.x takes a level,
 * and a model that wants one rejects the other. The budget is sent and dropped on retry
 * if the API says it does not want it, rather than pinning this to a model generation.
 *
 * **`additionalProperties` is not in the schema dialect** the response and parameter
 * schemas accept, so it is stripped on the way out.
 *
 * **There is no tool-runner helper**, so the agent loop below is written out by hand.
 * That is the part of this file most worth reading twice.
 *
 * Auth: GEMINI_API_KEY, or GOOGLE_API_KEY which the SDK also reads.
 */

export const name = "gemini";
export const label = "Google Gemini";
export const envKeys = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/**
 * The generally available Pro model rather than the newest preview: every stage here is
 * a judgement call, and a preview id that 404s on a Tuesday is a worse failure than a
 * model half a generation behind. Point ROBOT_MODEL at whatever is current.
 */
export const defaultModel = "gemini-2.5-pro";
export const authHint = "set GEMINI_API_KEY";

/**
 * Estimates only, for the cost lines in reports. Check these against current published
 * pricing before quoting them at anyone — they are not read by any decision the tool makes.
 */
export const pricing = {
  inputPerMTok: 1.25,
  outputPerMTok: 10,
  cachedInputPerMTok: 0.31,
};

/** Share of the ceiling handed to thinking. Always leaves room for the answer. */
const THINKING_SHARE = 0.5;
/** Pro will not think for less than 128 tokens and no model accepts more than 24576. */
const MIN_THINKING = 128;
const MAX_THINKING = 24576;

export function thinkingBudget(maxTokens: number): number {
  return Math.max(
    MIN_THINKING,
    Math.min(MAX_THINKING, Math.floor(maxTokens * THINKING_SHARE)),
  );
}

/** Finish reasons that mean "this input", not "this setup". */
const DECLINED = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
]);

/** JSON Schema in the dialect Gemini accepts. */
export function schemaFor(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaFor);
  if (schema === null || typeof schema !== "object") return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties" || key === "$schema") continue;
    out[key] = schemaFor(value);
  }
  return out;
}

function jsonSchemaOf(schema: z.ZodType<unknown>): Record<string, unknown> {
  return schemaFor(z.toJSONSchema(schema)) as Record<string, unknown>;
}

function usageOf(response: GenerateContentResponse): Usage {
  const meta = response.usageMetadata;
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    // Thinking is billed as output, and omitting it would understate every estimate.
    outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
  };
}

function client(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new LLMError(`no Gemini credential found — ${authHint}`);
  }
  return new GoogleGenAI({ apiKey });
}

export function explain(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  const status = (error as { status?: number })?.status;

  // A bad key here is a 400 INVALID_ARGUMENT rather than a 401, so status alone would
  // send the commonest setup mistake to the least useful message. The body says what
  // the status will not.
  if (status === 401 || status === 403 || /api key not valid|api_key_invalid/i.test(message)) {
    return [
      "Google rejected the credentials.",
      "",
      `Fix: ${authHint} to a valid key. The SDK also reads GOOGLE_API_KEY.`,
      "",
      "To use a different vendor instead, set ANTHROPIC_API_KEY and unset the Google",
      "variables.",
    ].join("\n");
  }
  if (status === 429) return `Google rate limited the request.\n${message}`;
  if (status !== undefined && status >= 500) {
    return `Google returned ${status}. This is usually transient.\n${message}`;
  }
  return message;
}

/** Read the answer text, leaving out thought summaries — they are not the answer. */
function answerText(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part: Part) => part.text && !part.thought)
    .map((part: Part) => part.text)
    .join("");
}

function checkCandidate(response: GenerateContentResponse, maxTokens: number): void {
  const blocked = String(response.promptFeedback?.blockReason ?? "");
  if (blocked && blocked !== "BLOCKED_REASON_UNSPECIFIED") {
    throw new LLMError(`Gemini declined this input (${blocked}).`);
  }
  const candidate = response.candidates?.[0];
  if (!candidate) throw new LLMError("Gemini returned no candidates.");

  const finish = String(candidate.finishReason ?? "");
  if (DECLINED.has(finish)) {
    throw new LLMError(`Gemini declined this input (${finish}).`);
  }
  if (finish === "MAX_TOKENS") {
    throw new LLMError(
      `Gemini hit the ${maxTokens}-token ceiling before finishing — the output is truncated. ` +
        `Raise max_tokens or narrow the request.`,
    );
  }
}

/**
 * Send, and drop the thinking budget if this model generation wants the other knob.
 * Its own default is a sensible one, so dropping ours beats failing the run.
 */
async function send(
  ai: GoogleGenAI,
  model: string,
  contents: Content[],
  config: Record<string, unknown>,
  maxTokens: number,
): Promise<GenerateContentResponse> {
  const withThinking = {
    ...config,
    thinkingConfig: { thinkingBudget: thinkingBudget(maxTokens) },
  };
  try {
    return await ai.models.generateContent({ model, contents, config: withThinking });
  } catch (error) {
    const message = (error as Error)?.message ?? "";
    if (!/thinking|budget/i.test(message)) throw error;
    return ai.models.generateContent({ model, contents, config });
  }
}

export async function askJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
  const ai = client();
  let response: GenerateContentResponse;

  try {
    response = await send(
      ai,
      request.model,
      [{ role: "user", parts: [{ text: request.user }] }],
      {
        systemInstruction: request.system,
        maxOutputTokens: request.maxTokens,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchemaOf(request.schema as z.ZodType<unknown>),
      },
      request.maxTokens,
    );
  } catch (error) {
    throw new LLMError(explain(error));
  }

  checkCandidate(response, request.maxTokens);

  const raw = answerText(response);
  const usage = usageOf(response);
  if (!raw.trim()) return { value: null, usage };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LLMError(
      `Gemini returned text that is not JSON: ${raw.slice(0, 200)}`,
    );
  }

  // The schema was requested, but it is the local one that decides.
  const checked = request.schema.safeParse(parsed);
  return { value: checked.success ? checked.data : null, usage };
}

/**
 * The agent loop, written out because Gemini has no tool-runner helper.
 *
 * The one thing that must not be got wrong: the model's own turn — including its
 * functionCall parts — has to be appended before the responses to it, or the
 * conversation is malformed and the next call fails in a way that reads like a
 * schema problem.
 */
export async function runTools(request: ToolRequest): Promise<ToolResult> {
  const ai = client();

  const declarations = request.tools.map((tool) => {
    const schema = jsonSchemaOf(tool.inputSchema);
    const properties = schema.properties as Record<string, unknown> | undefined;
    return {
      name: tool.name,
      description: tool.description,
      // A parameters schema with no properties is rejected, and several tools
      // legitimately take no arguments.
      ...(properties && Object.keys(properties).length > 0
        ? { parametersJsonSchema: schema }
        : {}),
    };
  });

  const contents: Content[] = [
    { role: "user", parts: [{ text: request.user }] },
  ];
  const config = {
    systemInstruction: request.system,
    maxOutputTokens: request.maxTokens,
    tools: [{ functionDeclarations: declarations }],
  };

  let usage = NO_USAGE;
  let turns = 0;
  let stopReason: ToolResult["stopReason"] = "completed";

  while (turns < request.maxIterations) {
    let response: GenerateContentResponse;
    try {
      response = await send(ai, request.model, contents, config, request.maxTokens);
    } catch (error) {
      throw new LLMError(explain(error));
    }

    turns += 1;
    usage = addUsage(usage, usageOf(response));
    checkCandidate(response, request.maxTokens);

    if (request.onTurn && !request.onTurn(usage)) {
      stopReason = "budget";
      break;
    }

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      stopReason = "completed";
      break;
    }

    // The model's turn goes back verbatim, functionCall parts and all.
    contents.push({
      role: "model",
      parts: response.candidates?.[0]?.content?.parts ?? [],
    });

    const responses: Part[] = [];
    for (const call of calls) {
      const output = await invokeTool(request.tools, call.name ?? "", call.args);
      responses.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name: call.name ?? "",
          response: { output },
        },
      });
    }
    contents.push({ role: "user", parts: responses });

    if (turns >= request.maxIterations) stopReason = "max-iterations";
  }

  return { turns, usage, stopReason };
}

export const provider: Provider = {
  name,
  label,
  envKeys,
  defaultModel,
  authHint,
  pricing,
  askJson,
  runTools,
};
