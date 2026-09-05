#!/usr/bin/env node
import fs from "node:fs";
import { loadConfig, outPath } from "./config.js";

const USAGE = `
AITestRobot

  robot surface [--no-probe]        Stage 1  Extract the SurfaceMap (deterministic)
  robot divergence                  Stage 1  Compare SPEC against the extracted rules
  robot synth   [--screen <route>]  Stage 2  Generate test cases from SurfaceMap + SPEC
  robot run     [--filter <sub>]    Stage 3  Compile and execute the corpus
  robot adjudicate                  Stage 4  Triage the last run's failures
  robot explore [--screen <route>]           Drive the app agentically to discover cases
  robot mutations                            List the injectable defects
  robot eval                        Stage 5  Mutation-score the corpus

Options
  --no-probe        Skip the browser probe; static extraction only
  --screen <route>  Restrict synthesis or exploration to one route
  --filter <sub>    Run only test cases whose id contains <sub>
  --mutation <id>   Arm one mutation for the duration of the run
  --adjudicate      After a run, triage any failures immediately
  --as <role>       Explore signed in as this role (default: probeAs)
  --fixture <name>  Database fixture to explore against
  --turns <n>       Cap the explorer's agent turns (default 24)
  --budget <usd>    Stop exploring once the run has cost this much (default 1.00)
  --no-verify       Skip replaying explorer proposals before admitting them

Stages 1, 3 and 5 run entirely offline. divergence, synth and adjudicate call the
Claude API and need a credential.
`.trimStart();

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith("--") ? next : "true";
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = loadConfig();

  switch (command) {
    case "surface": {
      const { buildSurfaceMap } = await import("./surface/merge.js");
      const { printSurface } = await import("./report/print.js");
      const map = await buildSurfaceMap(config, { probe: !has("no-probe") });
      const target = outPath(config, "surface.json");
      fs.writeFileSync(target, JSON.stringify(map, null, 2));
      printSurface(map, target);
      return 0;
    }

    case "synth": {
      const { synthesize } = await import("./synth/synth.js");
      await synthesize(config, { screen: flag("screen") });
      return 0;
    }

    case "divergence": {
      const { detectDivergence } = await import("./oracle/divergence.js");
      const { printDivergence } = await import("./report/print.js");
      printDivergence(await detectDivergence(config));
      return 0;
    }

    case "run": {
      const { runSuite } = await import("./exec/runner.js");
      const mutation = flag("mutation");
      const result = await runSuite(config, {
        filter: flag("filter"),
        mutations: mutation ? [mutation] : [],
      });
      if (has("adjudicate") && result.fail + result.blocked > 0) {
        const { adjudicate } = await import("./adjudicate/triage.js");
        const { printAdjudication } = await import("./report/print.js");
        printAdjudication(await adjudicate(config));
      }
      return result.fail > 0 ? 1 : 0;
    }

    case "adjudicate": {
      const { adjudicate } = await import("./adjudicate/triage.js");
      const { printAdjudication } = await import("./report/print.js");
      printAdjudication(await adjudicate(config));
      return 0;
    }

    case "explore": {
      const { explore } = await import("./explore/explorer.js");
      const { printExplore } = await import("./report/print.js");
      const turns = flag("turns");
      const budget = flag("budget");
      printExplore(
        await explore(config, {
          screen: flag("screen"),
          as: flag("as"),
          fixture: flag("fixture"),
          maxIterations: turns ? Number(turns) : undefined,
          budgetUsd: budget ? Number(budget) : undefined,
          noVerify: has("no-verify"),
        }),
      );
      return 0;
    }

    case "mutations": {
      const { listMutations } = await import("./harness.js");
      const { available, active } = await listMutations(config);
      console.log(`${available.length} injectable defects (active: ${active.length || "none"})\n`);
      for (const mutation of available) {
        console.log(
          `  ${mutation.id.padEnd(20)} ${mutation.specRef.padEnd(9)} ${mutation.description}`,
        );
      }
      return 0;
    }

    case "eval": {
      const { runEval } = await import("./mutation/eval.js");
      await runEval(config);
      return 0;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      process.stdout.write(USAGE);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\n${(error as Error).message}`);
    process.exit(1);
  });
