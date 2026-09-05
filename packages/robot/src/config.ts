import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const configSchema = z.object({
  appName: z.string(),
  baseUrl: z.string().url(),
  apiUrl: z.string().url(),
  spec: z.string(),
  sources: z.object({
    schemas: z.array(z.string()),
    routes: z.array(z.string()),
    endpoints: z.array(z.string()),
  }),
  /** Concrete URL to visit for a parameterised route. */
  routeSamples: z.record(z.string()).default({}),
  auth: z.object({
    storageKey: z.string(),
    tokenEndpoint: z.string(),
    users: z.record(z.number()),
  }),
  testControl: z.object({
    reset: z.string(),
    mutations: z.string(),
  }),
  /**
   * How to re-read a record through the API to prove a write actually landed.
   * Maps a page route to the endpoint that serves the same record.
   */
  persistence: z
    .array(z.object({ route: z.string(), api: z.string() }))
    .default([]),
  probeAs: z.string().default("admin"),
  outDir: z.string().default("artifacts"),
  testcaseDir: z.string().default("testcases"),
});

export type RobotConfig = z.infer<typeof configSchema> & { root: string };

/** Walk up from cwd until robot.config.json turns up. */
export function findRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "robot.config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("robot.config.json not found in any parent directory");
    }
    dir = parent;
  }
}

export function loadConfig(root = findRoot()): RobotConfig {
  const raw = JSON.parse(
    fs.readFileSync(path.join(root, "robot.config.json"), "utf8"),
  );
  return { ...configSchema.parse(raw), root };
}

export function resolveGlobs(config: RobotConfig, globs: string[]): string[] {
  return globs.map((glob) => path.join(config.root, glob).replace(/\\/g, "/"));
}

export function outPath(config: RobotConfig, ...parts: string[]): string {
  const target = path.join(config.root, config.outDir, ...parts);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}
