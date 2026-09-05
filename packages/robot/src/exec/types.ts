export type Verdict =
  | "PASS"
  | "FAIL"
  | "DIVERGENCE"
  | "CHARACTERIZED"
  | "FLAKE"
  | "BLOCKED";

export interface Outcome {
  id: string;
  title: string;
  screen: string;
  verdict: Verdict;
  /** One line saying what actually happened. */
  detail?: string;
  assertionSource: "spec" | "code" | "both";
  specRef?: string;
  durationMs: number;
  /** Which link of the locator chain resolved each target — drift evidence. */
  locatorStrategies: Record<string, string>;
}

export interface RunResult {
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  characterized: number;
  durationMs: number;
  mutations: string[];
  outcomes: Outcome[];
}

/** Requests the page made, so apiCalled / apiNotCalled can be decided. */
export interface RequestLog {
  method: string;
  url: string;
  status?: number;
}
