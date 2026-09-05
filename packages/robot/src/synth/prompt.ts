import { ACTIONS, ASSERTIONS } from "./testcase.js";
import type { ProbedScreen, SurfaceMap, SurfaceSchema } from "../types.js";

/**
 * The system prompt is frozen and cached; only the per-screen brief varies.
 * See PLAN.md section 2 — the model's job is to reason over a complete surface, never
 * to go looking for one.
 */
export function systemPrompt(spec: string): string {
  return `
You generate executable test cases for a web application.

# The one rule that matters

You are given two independent sources of truth, and you must not let them cross.

- The REQUIREMENTS say what *should* be true. They are the only thing that can justify
  calling behaviour wrong.
- The CODE SURFACE says what *exists* — routes, fields, rules, controls. It tells you what
  is worth testing. It does NOT tell you what is correct.

If you derive an expectation from the implementation and label it as a requirement, the
test asserts that the code does what the code does. It will pass, it will look like
coverage, and it will be worthless. Every existing bug would become expected behaviour.

So every case you write carries an honest \`assertionSource\`:

- "spec" — the expectation traces to a specific requirement. Set \`specRef\` to its ID.
  Only these may report a real failure.
- "code" — you read the expectation off the implementation and no requirement covers it.
  This is a characterization test: it locks in current behaviour so a change is visible.
  It is NOT a claim that the behaviour is right. Do not invent a specRef for these.
- "both" — a requirement covers it AND the code agrees. The strongest case to write.

Be honest in this field. A "spec" tag with no requirement genuinely behind it is the
single worst thing you can produce here. When in doubt, tag it "code".

If you notice the requirements and the code contradicting each other, still write the
case from the REQUIREMENT, tag it "spec", and say so plainly in the rationale. A failure
there is a real finding.

# Vocabulary

Steps — actions: ${ACTIONS.join(", ")}
Expectations — assertions: ${ASSERTIONS.join(", ")}

Rules for steps and expectations:
- \`target\` is always a semantic name taken from the AVAILABLE TARGETS list for the
  screen. Never a CSS selector, never coordinates, never a guess.
- Every case must start with a \`goto\` step whose target is a concrete path.
- \`apiNotCalled\` proves the browser blocked a request before it was sent.
- \`persisted\` re-reads the record through the API. It is the only way to tell a real
  save from a request that returned 200 and stored nothing — the form just shows you
  what you typed. Use it for anything that claims to save.
- Validation error elements follow the pattern \`error-<fieldName>\`.
- To assert a field is rejected, assert the error element is \`visible\` AND use \`text\`
  with a short distinctive \`match\` substring. Do not paste the whole message.

# What to cover

For each field, work through the rule classes deliberately:
- the happy path
- each boundary, from both sides (if minimum is 2, test 1 and 2)
- each format or pattern rule, with a value that plausibly fails it
- conditional rules, in both the condition-holds and condition-does-not-hold directions
- enum fields, including a value outside the enum where the interface permits one
- permission rules, from the perspective of a role that should be denied
- persistence, for anything that saves

Prefer many small, independent cases over a few long ones. Each must stand alone.

Two things generated suites habitually miss — cover them:
1. A rule enforced in the browser but not on the server. Where a requirement says the
   server enforces something, write a case that proves it, not just one that checks the
   error message appears.
2. A save that reports success without storing anything. Use \`persisted\`.

# Requirements

${spec}
`.trim();
}

export function screenBrief(
  map: SurfaceMap,
  screen: ProbedScreen,
  schemas: SurfaceSchema[],
  roles: string[],
): string {
  const targets = screen.controls
    .filter((control) => control.testId)
    .map((control) => {
      const bits = [`  - ${control.testId}`, `(${control.tag}`];
      if (control.type) bits.push(control.type);
      bits.push(")");
      if (control.label) bits.push(`label "${control.label}"`);
      if (control.disabled) bits.push("[disabled for the probing role]");
      if (control.options?.length) bits.push(`options: ${control.options.join(", ")}`);
      return bits.join(" ");
    })
    .join("\n");

  const rules = schemas
    .map((schema) => {
      const fields = schema.fields
        .map((field) => {
          const parts = field.rules
            .filter((rule) => rule.kind !== "type")
            .map((rule) => {
              const value =
                rule.value === undefined ? "" : `=${JSON.stringify(rule.value)}`;
              const message = rule.message ? ` msg:"${rule.message}"` : "";
              return `${rule.kind}${value}${message}`;
            })
            .join(", ");
          return `  ${field.name} (${field.type}): ${parts}`;
        })
        .join("\n");

      const refinements = schema.refinements
        .map(
          (refinement) =>
            `  ${refinement.field}: raises "${refinement.message}" when \`${refinement.condition}\``,
        )
        .join("\n");

      return `${schema.name}\n${fields}\n\ncross-field rules:\n${refinements}`;
    })
    .join("\n\n");

  return `
# Screen under test

Route: ${screen.route}
Concrete URL to visit: ${screen.url}

# Available targets on this screen

${targets || "  (none captured)"}

# Accessibility snapshot

${screen.snapshot}

# Declared validation rules (read from the source — this is what EXISTS, not what is correct)

${rules || "  (no schema covers this screen)"}

# Application routes

${map.routes.map((route) => `  ${route.path}`).join("\n")}

# API endpoints

${map.endpoints.map((endpoint) => `  ${endpoint.method} ${endpoint.path}`).join("\n")}

# Available auth roles for preconditions

  ${roles.join(", ")}

# Available reset fixtures

  users.basic (5 staff), users.permissions (one per role), users.paging (25 staff)

Generate the test cases for this screen now. Give every case a stable, descriptive id
prefixed TC-, in SCREAMING-KEBAB-CASE.
`.trim();
}
