import Anthropic from "@anthropic-ai/sdk";

/**
 * One place to build the API client, so every model-calling stage fails the same
 * legible way when credentials are wrong.
 */

export const MODEL = "claude-opus-5";

/** claude-opus-5: $5/MTok in, $25/MTok out, cache reads at 0.1x input. */
export function estimateCost(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
}): number {
  return (
    (usage.input_tokens / 1e6) * 5 +
    (usage.output_tokens / 1e6) * 25 +
    ((usage.cache_read_input_tokens ?? 0) / 1e6) * 0.5
  );
}

export function client(): Anthropic {
  return new Anthropic();
}

/**
 * Turn an SDK failure into something the reader can act on.
 *
 * The 401 case is worth special handling: an inherited ANTHROPIC_AUTH_TOKEN or
 * ANTHROPIC_BASE_URL from a surrounding agent harness will be picked up by the SDK ahead
 * of anything else, and the resulting "Invalid bearer token" gives no clue why a key you
 * just exported is being ignored.
 */
export function explainApiError(error: unknown): string {
  const status = (error as { status?: number })?.status;
  const message = (error as Error)?.message ?? String(error);

  if (status === 401 || status === 403) {
    const lines = [
      "The Claude API rejected the credentials.",
      "",
      "The SDK resolves credentials in this order, first match wins:",
      "  ANTHROPIC_API_KEY -> ANTHROPIC_AUTH_TOKEN -> an `ant auth login` profile",
      "",
    ];

    if (process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
      lines.push(
        "ANTHROPIC_AUTH_TOKEN is set in this environment and ANTHROPIC_API_KEY is not,",
        "so the token is being used. If that token belongs to a surrounding agent or",
        "proxy rather than to you, it will not authenticate here.",
        "",
      );
    }
    // Only worth mentioning when it actually redirects traffic — the default value
    // being set is not itself a problem, and saying so sends people the wrong way.
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    const redirected =
      baseUrl && !/^https:\/\/api\.anthropic\.com\/?$/.test(baseUrl.trim());
    if (redirected) {
      lines.push(
        `ANTHROPIC_BASE_URL points at ${baseUrl}, so requests are not reaching the`,
        "Claude API directly.",
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
      "Or authenticate once with `ant auth login`.",
    );
    return lines.join("\n");
  }

  if (status === 429) {
    return `Rate limited by the Claude API. Retry shortly.\n${message}`;
  }
  if (status !== undefined && status >= 500) {
    return `The Claude API returned ${status}. This is usually transient.\n${message}`;
  }
  return message;
}

/** Run a model call, replacing an opaque SDK error with an actionable one. */
export async function withApiErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(explainApiError(error));
  }
}
