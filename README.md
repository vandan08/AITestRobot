# AITestRobot

An AI layer that reads an application's **code** and its **requirements**, generates an
executable test corpus from both, runs it in a real browser, and reports where the
application, the code, and the requirements disagree.

The design rationale — and the reason most "AI writes your tests" tools produce
meaningless green suites — is in [PLAN.md](PLAN.md). The short version:

> If you derive expectations from the implementation, the suite asserts that the code does
> what the code does. Every existing bug becomes expected behaviour. So the code decides
> *what to test*; the requirements decide *what should be true*; and where they disagree,
> that is the finding.

---

## Quick start

```bash
npm install
npx playwright install chromium
```

Start the demo application under test (API on :4000, web on :5173):

```bash
npm run demo
```

Then, in a second terminal:

```bash
npx tsx packages/robot/src/cli.ts surface   # Stage 1 — extract, no model involved
npx tsx packages/robot/src/cli.ts run       # Stage 3 — execute the corpus
npx tsx packages/robot/src/cli.ts eval      # Stage 5 — mutation-score the corpus
```

`divergence`, `synth` and `adjudicate` call the Claude API and need a credential — either
`ANTHROPIC_API_KEY`, or `ant auth login`. Every other command runs entirely offline.

> **If you get "Invalid bearer token" with a key exported:** the SDK resolves
> `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → profile, first match wins. An agent
> harness or proxy in the surrounding shell may have exported `ANTHROPIC_AUTH_TOKEN`, which
> then wins over nothing and loses to your key only if yours is set. `unset
> ANTHROPIC_AUTH_TOKEN` and export your own. The CLI explains this when it happens.

---

## Commands

| Command | Stage | Model? | What it does |
|---|---|---|---|
| `robot surface` | 1 | no | AST-extracts routes, endpoints, and validation rules; probes each screen in a browser; writes `artifacts/surface.json` |
| `robot divergence` | 1 | **yes** | Compares `SPEC.md` against the extracted rules and reports where they disagree |
| `robot synth` | 2 | **yes** | Generates a test corpus from the surface map + `SPEC.md` into `testcases/generated.json` |
| `robot run` | 3 | no | Compiles the corpus to Playwright calls and executes it |
| `robot adjudicate` | 4 | **yes** | Triages the last run's failures from the evidence captured at failure time |
| `robot eval` | 5 | no | Injects each known defect in turn and scores what the corpus catches |
| `robot mutations` | — | no | Lists the injectable defects |

Useful flags: `--no-probe`, `--screen <route>`, `--filter <substring>`, `--mutation <id>`,
`--adjudicate`.

### Divergence — the finding a test suite cannot make

A suite can only tell you whether the application matches the *code's* idea of correct. It
cannot tell you a requirement never reached the code at all: there is nothing to execute,
so nothing fails, and the gap stays invisible.

`robot divergence` compares the requirements against the Stage 1 rules and reports three
kinds of disagreement — `contradiction`, `unimplemented`, and `undocumented` (a code rule
no requirement covers, so tests for it can only ever be `code`-sourced). Every finding must
quote both sides; findings that cite a requirement id not present in `SPEC.md`, or that
omit the verbatim quote, are dropped before you see them. Reporting nothing is a valid
outcome — a false divergence costs someone an hour and teaches them to ignore the report.

### Adjudication — advisory, always

A failing test says something is wrong, not *what*. `robot adjudicate` reads the evidence
captured at failure time — the accessibility tree, the data requests actually sent, which
locator strategy resolved each target — and classifies: `REAL_BUG`, `SELECTOR_DRIFT`,
`TEST_WRONG`, `ENV_FLAKE`, or `UNDETERMINED`.

**Triage never changes a verdict.** It annotates. A model that can reclassify a real
failure as a flake is not a triage system, it is a way to turn a red build green, so that
path does not exist — which is also why the adjudicator has no reason to hedge.

---

## Verdicts

Six, not two — because pass/fail cannot express what this tool learns.

| Verdict | Meaning |
|---|---|
| `PASS` | Behaved as required |
| `FAIL` | A **spec-sourced** expectation was violated — a real defect |
| `DIVERGENCE` | The spec and the code disagree; found before execution |
| `CHARACTERIZED` | A code-sourced test recorded current behaviour |
| `FLAKE` | Non-deterministic |
| `BLOCKED` | A precondition or a locator failed; the case never reached an assertion |

**`CHARACTERIZED` is not a pass.** It means "the code still does what it did", which is a
regression signal and not a quality claim. Reporting it as green is how these tools end up
lying to the people reading their output.

---

## Current results

The corpus in `testcases/seed.json` is **hand-written**, deliberately: it establishes
whether the runner itself is trustworthy before any generated case is measured against it.

```
Baseline — unmutated application
  7 cases  7 pass  0 false positives  0 blocked

  mutation score      4/10  (40%)
  false positives     0.0%
  blocked             0.0%
  duration            84.6s
```

The six survivors are the interesting part — they are where a suite written by a competent
human, in a hurry, is blind:

| Survivor | Class | Why it survived |
|---|---|---|
| `phone-length` | off-by-one | No case probes the 9-digit boundary |
| `age-min` | boundary | No case covers the age rule at all |
| `bio-max` | boundary | No case covers the 500-character bound |
| `role-enum` | enum | No case submits a role outside the enum |
| `status-permission` | **authorization** | The suite checks the control is *disabled*, but never that the **server** rejects the change — REQ-3.2 requires both |
| `email-unique` | server-only rule | Uniqueness is unenforceable in the browser and untested |

`status-permission` is the one worth dwelling on. The test passes, the requirement is only
half-covered, and nothing in a conventional report would tell you. That is the gap
generation has to close to be worth anything.

---

## Layout

```
PLAN.md                  design and rationale
SPEC.md                  requirements — the assertion oracle
robot.config.json        how the robot reaches the app under test
testcases/seed.json      hand-written baseline corpus
packages/robot/          the tool
apps/demo/               the system under test
artifacts/               surface.json, run.json, eval.json
```

`packages/robot` reaches the application only through `robot.config.json`, so pointing it
at a different app is a config change rather than a rewrite.

---

## The demo application

`apps/demo` is a staff directory built for this purpose — mutation testing needs an
application you are allowed to break on demand, and the PoC should not be blocked on
another project's toolchain.

It carries a registry of ten deliberate defects (`apps/demo/shared/mutations.ts`), armed at
runtime via `POST /__test__/mutations`. Each breaks exactly one requirement. The
validation-rule mutations are applied on **both** the client and the server, because a
mutation stands in for a developer weakening a rule in the shared schema — applying it
server-only would let a UI test pass on client-side validation alone and appear to have
caught a defect it never detected.

`SPEC.md` also contains one requirement (REQ-2.6) that the implementation does not honour.
That is a fixture, not a bug — it is the reference case for the `DIVERGENCE` verdict.
