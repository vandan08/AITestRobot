#!/usr/bin/env node
import fs from "node:fs";
import { loadConfig, outPath } from "./config.js";

const USAGE = `
AITestRobot

  robot surface [--no-probe]        Stage 1  Extract the SurfaceMap (deterministic)
  robot synth   [--screen <route>]  Stage 2  Generate test cases from SurfaceMap + SPEC
  robot run     [--filter <sub>]    Stage 3  Compile and execute the corpus
  robot mutations                            List the injectable defects
  robot eval                        Stage 5  Mutation-score the corpus

Options
  --no-probe        Skip the browser probe; static extraction only
  --screen <route>  Restrict synthesis to one route
  --filter <sub>    Run only test cases whose id contains <sub>
  --mutation <id>   Arm one mutation for the duration of the run
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

    case "run": {
      const { runSuite } = await import("./exec/runner.js");
      const mutation = flag("mutation");
      const result = await runSuite(config, {
        filter: flag("filter"),
        mutations: mutation ? [mutation] : [],
      });
      return result.fail > 0 ? 1 : 0;
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
