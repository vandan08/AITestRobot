# AITestRobot

An AI layer that reads an application's **code** and its **requirements**, generates an
executable test corpus from both, runs it against a real browser, and reports where the
application, the code, and the requirements disagree.

Status: **The deterministic pipeline runs end to end and is verified**, and **Stage 1's
divergence detector is verified on Gemini** — it finds the seeded REQ-2.6 contradiction
with no false positives, for well under a cent. Synthesis, adjudication and exploration
are written but not yet run. Hand-written baseline: 7/7 passing, 0 false positives,
**4/10 mutation score**. Runs on Anthropic or Google Gemini, whichever is configured.
See [Milestones](#milestones).

---

## 1. The problem this is actually solving

"Point an LLM at a repo and let it write tests" produces a suite that passes. That is the
failure mode, not the success case.

If expectations are derived from the implementation, the suite asserts that the code does
what the code does. Every existing bug is silently promoted to expected behaviour. You get
400 green tests and zero information.

This is the **oracle problem**, and it is the axis the whole design turns on.

### The resolution

Keep two independent sources of truth and never let them cross:

| Source | Answers | Used for |
|---|---|---|
| **Code** (static + runtime) | *What exists?* Routes, fields, rules, endpoints | Coverage enumeration |
| **Spec** (`SPEC.md`, requirements) | *What should be true?* | Assertions |

Every generated test carries an `assertionSource` tag, and it is load-bearing:

- `spec` — the expectation traces to a requirement. **This test may report a real `FAIL`.**
- `code` — the expectation was read off the implementation. This is a *characterization*
  test: it locks in current behaviour for regression, and its failure means "behaviour
  changed", never "behaviour is wrong".
- `both` — spec and code agree. Strongest signal.

And where the two sources *disagree* before a browser ever opens, that is not a pass or a
fail. It is a third verdict:

- `DIVERGENCE` — e.g. the spec says `phone` is mandatory for clinicians; the zod schema
  marks it `.optional()`. Nobody's test suite catches this. It is the most valuable output
  the tool produces.

---

## 2. Pipeline

Five stages. Most of them do **not** involve a model.

```
  SPEC.md ────────────────────────────────────┐
                                              │
  repo ──► [1] Surface Extraction ──► SurfaceMap
              (deterministic: AST + runtime probe)
                                              │
                                              ▼
                                    [2] Test Synthesis  ◄── model (structured output)
                                              │
                                              ▼
                                        TestCase[] (DSL, on disk, reviewable, committed)
                                              │
                                              ▼
                                    [3] Compile ──► Playwright steps
                                              │
                                              ▼
                                       Execute (zero inference)
                                              │
                                        pass ─┴─ fail
                                              │
                                              ▼
                                    [4] Adjudication  ◄── model (failures only)
                                              │
                                              ▼
                                        [5] Report
```

| Stage | Job | Model? | Cost per run |
|---|---|---|---|
| 1. Surface extraction | Routes, fields, validation rules, endpoints, rendered controls | **No** — ts-morph AST + a11y probe | £0 |
| 2. Test synthesis | SurfaceMap + Spec → `TestCase[]` | Yes — structured output, whichever provider is keyed | Once, cached |
| 3. Execution | Compile the DSL to Playwright, run it | **No** | £0 |
| 4. Adjudication | Triage failures: real bug / drift / bad test / flake. **Advisory — never changes a verdict** | Yes — failures only | ~0 |
| 5. Report | HTML + JSON, verdict breakdown | No | £0 |

### Why "compile, don't interpret"

An LLM in the inner loop of every click is slow, expensive, and **non-reproducible** — run
it twice, get two traces. That is the opposite of a test.

So the model's output is an *artifact*, not an action. Stage 2 emits a `TestCase[]` that is
written to disk, reviewed by a human, and committed. Stage 3 compiles it to deterministic
locator calls and runs it thousands of times with zero inference. The model re-enters only
at Stage 4, on failure.

This gives two operating modes, and the relationship between them is the architecture:

- **Explorer** (agentic, non-deterministic, expensive) — runs occasionally, wanders the app,
  discovers what nobody wrote a case for. **Output: new test cases.**
- **Regression** (compiled, deterministic, fast, free) — runs on every commit.

*The explorer's job is to feed the regression suite.*

Which raises the obvious hazard: a non-deterministic proposer feeding a deterministic
corpus is exactly how suites become flaky. So nothing the explorer proposes enters the
corpus on its word — every proposal is replayed from a fresh reset in a fresh browser
first, and only `PASS`/`CHARACTERIZED` are admitted. The rest are quarantined for review,
because a spec-sourced proposal that fails on the clean application may have found a
genuine defect, which is the single most valuable thing exploration can produce.

And exploration is **inherently code-sourced**: watching a running application teaches you
what it does, never what it should do. Proposals default to `assertionSource: "code"`, and
a `spec` claim naming a requirement absent from `SPEC.md` is rejected — the same gate
synthesis passes through.

---

## 3. Stage 1 — Surface extraction (deterministic)

The single biggest quality lever. Do **not** hand a model the repo and ask it to "find the
requirements" — it will produce a plausible inventory that is missing three fields.

Extract mechanically first, then let the model reason over a complete, accurate structure.

### Static extractors (`ts-morph`)

| Extractor | Reads | Yields |
|---|---|---|
| `routes.ts` | `<Route path=… element=…>` in the router AST | Screen inventory |
| `schemas.ts` | `z.object({...})` chains | Fields, types, and every rule: `min`, `max`, `email`, `regex`, `optional`, `enum`, `refine` |
| `endpoints.ts` | `app.get/post/patch/delete(...)` | Method, path, params, handler binding |
| `permissions.ts` | `requireRole(...)` guards | Role-gated fields and routes |

### Runtime prober

Static analysis knows the *rules*; only a browser knows what is actually *rendered*. The
prober visits each route and captures Playwright's accessibility snapshot — roles, names,
states — which is also the cheap, stable representation handed to the model later.

### The merge is itself a finding

```
SurfaceMap = static (rules) × runtime (controls)
```

A field in the schema with no control on the page, or a control on the page with no schema
rule, is reported before any test runs.

---

## 4. The TestCase DSL

Test cases are data, not prose and not code. Human-readable, diffable, reviewable,
committed to the repo.

```jsonc
{
  "id": "TC-PROFILE-EMAIL-FORMAT",
  "screen": "/users/:id/edit",
  "feature": "user-profile",
  "kind": "negative",              // happy | boundary | negative | permission | persistence
  "priority": "P1",
  "assertionSource": "spec",       // spec | code | both   <-- the oracle discipline
  "specRef": "REQ-2.3",            // required when assertionSource includes "spec"
  "preconditions": [
    { "type": "reset" },
    { "type": "seed", "fixture": "users.basic" },
    { "type": "auth", "as": "admin" }
  ],
  "steps": [
    { "action": "goto",  "target": "/users/1/edit" },
    { "action": "fill",  "target": "email", "value": "not-an-email" },
    { "action": "click", "target": "save" }
  ],
  "expected": [
    { "assert": "visible", "target": "error-email" },
    { "assert": "text",    "target": "error-email", "match": "valid email" },
    { "assert": "apiNotCalled", "target": "PATCH /api/users/1" }
  ]
}
```

### Locator strategy

Targets are *semantic names*, never CSS selectors or coordinates. The compiler resolves each
through a fixed chain, and records which link resolved it so Stage 4 can detect drift:

```
data-testid  →  getByLabel  →  getByRole(name)  →  fail loudly
```

### Action surface

Small and semantic. `goto`, `fill`, `select`, `check`, `click`, `upload`, `waitFor`,
`apiSeed`, `apiCall`.

### Assertion surface

`visible`, `hidden`, `text`, `value`, `url`, `enabled`, `disabled`, `count`,
`apiCalled`, `apiNotCalled`, `persisted` (re-reads through the API to prove the write
actually landed — catches the "200 OK but nothing saved" class of bug).

---

## 5. Verdicts

Not pass/fail. Six outcomes, because pass/fail cannot express what this tool learns:

| Verdict | Meaning |
|---|---|
| `PASS` | Behaved as required |
| `FAIL` | **Spec-sourced** expectation violated — a real defect |
| `DIVERGENCE` | Spec and code disagree; found before execution |
| `CHARACTERIZED` | Code-sourced test recorded current behaviour (not a quality claim) |
| `FLAKE` | Non-deterministic; adjudicator's call |
| `BLOCKED` | Precondition or locator failed; test never got to assert |

A `CHARACTERIZED` result is **never** reported as a green tick. Conflating it with `PASS` is
how these tools lie to you.

---

## 6. Evaluation — does it actually work?

"It generated 400 test cases" is not a result. The measurement is **mutation testing**.

`apps/demo` ships a registry of deliberate defects, toggled at runtime via
`POST /__test__/mutations`. Each mutation breaks exactly one rule:

| # | Mutation | Class |
|---|---|---|
| `email-format` | Drop the email format check | Validation removed |
| `name-min` | `fullName` min 2 → 0 | Boundary weakened |
| `phone-length` | Accept 9 digits | Off-by-one |
| `dept-conditional` | Drop conditional-required on `department` | Conditional logic |
| `age-min` | Age gate 18 → 16 | Boundary weakened |
| `bio-max` | `bio` max 500 → 5000 | Boundary weakened |
| `status-permission` | Remove the role guard on `status` | **Authorization** |
| `email-unique` | Drop server-side uniqueness | Server-only rule |
| `phone-silent-drop` | `PATCH` returns 200 but never persists `phone` | **Silent data loss** |
| `role-enum` | Accept arbitrary role strings | Enum unenforced |

**Score = mutations caught / mutations injected**, counting only `FAIL` from spec-sourced
tests. Tracked alongside:

- **False-positive rate** — failures on the unmutated app. Must be ~0.
- **Cost per synthesis run** (USD) and **wall-clock per regression run**.
- **Blocked rate** — tests that never reached an assertion (locator quality proxy).

A suite catching 60%+ with a <5% flake rate is a genuinely interesting result. The
mutations that survive tell you exactly where generation is weak — that is the research
output.

---

## 7. Target application

The system under test is `apps/demo` — built for this purpose, and deliberately so:

1. Mutation testing needs an app you are *allowed* to break on demand.
2. The PoC must not be blocked on another project's toolchain.
3. Validation density per screen is what exercises the pipeline.

`packages/robot` talks to it only through a config file, so pointing it at a real
application later is a config change, not a rewrite.

**Screens:** `/login`, `/users` (list, search, pagination), `/users/:id/edit` (the dense one).

**`/users/:id/edit` field matrix** — chosen to cover every rule class:

| Field | Rules |
|---|---|
| `fullName` | required, 2–60 chars |
| `email` | required, format, **unique (server-side)** |
| `phone` | optional, exactly 10 digits |
| `role` | enum: admin / manager / clinician / viewer |
| `department` | **required only when role ≠ viewer** (conditional) |
| `dateOfBirth` | optional, past date, age ≥ 18 |
| `bio` | optional, max 500 |
| `notificationsEnabled` | boolean |
| `status` | enum, **admin-only** (permission-gated) |

---

## 8. Repo layout

```
AITestRobot/
├── PLAN.md
├── SPEC.md                        # Stage 0: requirements. The assertion oracle.
├── packages/robot/
│   ├── src/
│   │   ├── cli.ts
│   │   ├── config.ts
│   │   ├── surface/               # Stage 1 — deterministic
│   │   │   ├── routes.ts  schemas.ts  endpoints.ts  probe.ts  merge.ts
│   │   ├── synth/                 # Stage 2 — Claude
│   │   │   ├── testcase.ts        # the DSL (zod)  ── single source of truth
│   │   │   ├── prompt.ts  synth.ts
│   │   ├── exec/                  # Stage 3 — zero inference
│   │   │   ├── compile.ts  locator.ts  actions.ts  runner.ts
│   │   ├── adjudicate/            # Stage 4 — Claude, failures only
│   │   ├── oracle/divergence.ts   # spec × code comparison
│   │   ├── explore/               # agentic mode
│   │   ├── mutation/              # the eval harness
│   │   └── report/
└── apps/demo/                     # the system under test
    ├── shared/schema.ts           # zod — what Stage 1 extracts
    ├── server/                    # Express API + mutation registry
    └── web/                       # React + Vite
```

---

## 9. Stack

| Concern | Choice | Why |
|---|---|---|
| Browser | **Playwright** | Not Selenium. Auto-waiting, trace viewer, network interception, isolated parallel contexts — and critically, `_snapshotForAI()` gives an **accessibility-tree** snapshot. Screenshots cost 10–100× the tokens and force the model to guess coordinates. The a11y tree is what makes LLM-driven testing economically viable at all. |
| Language | TypeScript / Node 22, ESM | Playwright is first-class here; `ts-morph` gives real AST access for Stage 1 |
| Model | Anthropic or Google, whichever is keyed | Two call shapes only — `askJson` (schema in, object out) and `runTools` (agent loop) — which is a small enough contract for more than one vendor to honestly implement. Selection lives in `providers/`, what-to-send in `llm.ts`; no stage knows which API is on the other end. |
| Static analysis | `ts-morph` | Compiler API without the boilerplate |
| Validation | `zod` | One schema language for the DSL, config, and the SUT |

### State management

The unglamorous half, and the half that actually decides whether this works:

- `POST /__test__/reset` — restore the store to a known state between tests
- Named fixtures (`users.basic`, `users.permissions`) seeded via API, never via the UI
- Auth by injected `storageState`, not by driving the login form 400 times
- Frozen clock for the `dateOfBirth` age rule
- Every test independent; parallel-safe by construction

Skip this and nothing is reproducible — and an unreproducible suite is noise.

---

## 10. Milestones

| # | Scope | Status |
|---|---|---|
| **M0** | Workspace scaffold; demo SUT (schemas, API, 3 screens, reset/seed, mutation registry) | ✅ built, verified |
| **M1** | Stage 1: static extractors + runtime prober → `SurfaceMap` | ✅ built, verified |
| **M2** | TestCase DSL, compiler, locator chain, runner, reporter; hand-written seed cases prove the runner *before* the model is involved | ✅ built, verified — 7/7, 0 false positives |
| **M3** | Stage 2: Claude synthesis with structured output | ⚠️ built, **not yet run** — needs an API credential |
| **M5a** | Mutation eval harness + scorecard | ✅ built, verified — 4/10 on the hand-written baseline |
| **M4** | Stage 4 adjudication + `oracle/divergence` | ⚠️ built; evidence capture verified, model calls **not yet run** |
| **M5b** | Explorer mode | ⚠️ built; tool surface and gatekeeper tested (14 tests), agent loop **not yet run** |
| **M6** | Provider abstraction: Anthropic + Google Gemini, keyed selection | ✅ built; **divergence verified end to end on Gemini** — found the seeded REQ-2.6 fixture, 0 false positives, ~$0.006. synth / adjudicate / explore still unrun. |

M2 lands before M3 deliberately. If the runner is not trustworthy on hand-written cases,
nothing downstream of it can be measured. The eval harness landed early for the same
reason: the generated corpus needs a number to beat, and **4/10 with a 0% false-positive
rate** is that number.

---

## 11. Open questions

1. **How much spec is enough?** `SPEC.md` is hand-written today. If it must be exhaustive to
   be useful, the tool has just moved the work rather than removed it. Worth measuring: how
   coarse can the spec get before mutation-catch rate collapses?
2. **Locator durability.** `data-testid` makes the demo easy and real apps hard. Measure the
   `BLOCKED` rate against an app with no test IDs to find out what this costs in practice.
3. **Does the explorer earn its cost?** It only pays for itself if it finds cases synthesis
   missed. Measure: mutations caught *only* by explorer-discovered tests.
4. **Cross-field and multi-step state.** Single-screen rules are the easy half. Workflows
   spanning screens are where generated suites usually thin out.
