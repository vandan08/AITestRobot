/** Shared vocabulary for every stage. */

export type RuleKind =
  | "required"
  | "optional"
  | "min"
  | "max"
  | "email"
  | "regex"
  | "enum"
  | "type"
  | "conditional";

export interface FieldRule {
  kind: RuleKind;
  /** Bound, pattern source, or enum members. */
  value?: string | number | string[];
  /** The message the implementation raises, when it declares one. */
  message?: string;
  /** file:line the rule was read from. */
  source: string;
}

export interface SurfaceField {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "unknown";
  optional: boolean;
  rules: FieldRule[];
}

/** A cross-field rule. Extracted best-effort: we keep the guard verbatim. */
export interface Refinement {
  field: string;
  message: string;
  /** Source text of the condition that raises it. Handed to the model as-is. */
  condition: string;
  source: string;
}

export interface SurfaceSchema {
  name: string;
  file: string;
  fields: SurfaceField[];
  refinements: Refinement[];
}

export interface SurfaceRoute {
  path: string;
  component: string;
  source: string;
}

export interface SurfaceEndpoint {
  method: string;
  path: string;
  source: string;
}

export interface ProbedControl {
  tag: string;
  type?: string;
  testId?: string;
  label?: string;
  role?: string;
  name?: string;
  disabled?: boolean;
  options?: string[];
  /** Inside a <form>. Only these participate in schema reconciliation. */
  inForm?: boolean;
}

export interface ProbedScreen {
  route: string;
  url: string;
  reachable: boolean;
  controls: ProbedControl[];
  /** Accessibility-tree snapshot: the cheap, stable page representation. */
  snapshot: string;
  error?: string;
}

/**
 * A disagreement found during extraction, before any test runs.
 * Emitted by the merge step; see PLAN.md section 3.
 */
export interface SurfaceFinding {
  kind:
    | "field-without-control"
    | "control-without-rule"
    | "route-unreachable"
    | "endpoint-unused";
  detail: string;
  subject: string;
}

export interface SurfaceMap {
  generatedAt: string;
  appName: string;
  routes: SurfaceRoute[];
  endpoints: SurfaceEndpoint[];
  schemas: SurfaceSchema[];
  screens: ProbedScreen[];
  findings: SurfaceFinding[];
}
