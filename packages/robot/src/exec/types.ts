export type Verdict =
  | "PASS"
  | "FAIL"
  | "DIVERGENCE"
  | "CHARACTERIZED"
  | "FLAKE"
  | "BLOCKED";

/**
 * What the page looked like when a case failed.
 *
 * Captured at failure time and only at failure time. Stage 4 cannot triage a failure
 * from an error string alone — it needs to see whether the target was absent, renamed,
 * or present-but-wrong, and whether a request was actually sent.
 */
export interface Evidence {
  /** Which half of the case was running: the steps, or the assertions. */
  phase: "precondition" | "steps" | "expectations";
  /** Index within that phase. */
  index: number;
  /** The step or expectation being executed, serialised. */
  executing?: string;
  url?: string;
  /** Accessibility tree at the moment of failure. */
  snapshot?: string;
  requests: RequestLog[];
  errorName: string;
  errorMessage: string;
}

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
  evidence?: Evidence;
  /** Filled in by `robot adjudicate`. Advisory only — it never changes the verdict. */
  triage?: Triage;
}

export type Classification =
  | "REAL_BUG"
  | "SELECTOR_DRIFT"
  | "TEST_WRONG"
  | "ENV_FLAKE"
  | "UNDETERMINED";

export interface Triage {
  classification: Classification;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  /** What would have to change to resolve this. */
  repairTarget: "application" | "testcase" | "harness" | "none";
  suggestedRepair?: string;
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
  /** Playwright's resource type. Lets triage ignore document/script/style noise. */
  resourceType?: string;
}

/** The request kinds that represent application behaviour rather than page loading. */
export const DATA_RESOURCE_TYPES = new Set(["xhr", "fetch"]);
