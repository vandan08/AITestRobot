import type { RobotConfig } from "../config.js";
import { resolveGlobs } from "../config.js";
import { extractEndpoints, extractRoutes } from "./routes.js";
import { extractSchemas } from "./schemas.js";
import { probeScreens } from "./probe.js";
import type { SurfaceFinding, SurfaceMap } from "../types.js";

const NON_FIELD_CONTROLS = new Set(["button", "a"]);

/**
 * SurfaceMap = static (rules) x runtime (controls).
 *
 * The merge is not bookkeeping — the disagreements it turns up are findings in their own
 * right, reported before a single test runs.
 */
export async function buildSurfaceMap(
  config: RobotConfig,
  options: { probe?: boolean } = {},
): Promise<SurfaceMap> {
  const routes = extractRoutes(resolveGlobs(config, config.sources.routes));
  const endpoints = extractEndpoints(resolveGlobs(config, config.sources.endpoints));
  const schemas = extractSchemas(resolveGlobs(config, config.sources.schemas));

  const screens =
    options.probe === false ? [] : await probeScreens(config, routes);

  return {
    generatedAt: new Date().toISOString(),
    appName: config.appName,
    routes,
    endpoints,
    schemas,
    screens,
    findings: reconcile(schemas, screens),
  };
}

function reconcile(
  schemas: SurfaceMap["schemas"],
  screens: SurfaceMap["screens"],
): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  if (screens.length === 0) return findings;

  const rendered = new Set<string>();
  for (const screen of screens) {
    for (const control of screen.controls) {
      if (control.testId) rendered.add(control.testId);
      if (control.label) rendered.add(control.label.toLowerCase());
    }
  }

  for (const schema of schemas) {
    for (const field of schema.fields) {
      if (rendered.has(field.name)) continue;
      findings.push({
        kind: "field-without-control",
        subject: `${schema.name}.${field.name}`,
        detail:
          `Schema declares "${field.name}" but no probed screen renders a control ` +
          `for it. Either the field is unreachable through the interface, or the ` +
          `control is not addressable.`,
      });
    }
  }

  const declared = new Set(
    schemas.flatMap((schema) => schema.fields.map((field) => field.name)),
  );

  for (const screen of screens) {
    if (!screen.reachable) {
      findings.push({
        kind: "route-unreachable",
        subject: screen.route,
        detail: `Probe could not load ${screen.url}: ${screen.error ?? "unknown"}`,
      });
      continue;
    }

    // Only reconcile screens that are actually schema-backed. A login form or a
    // search box has no schema by design, and flagging every one of them buries
    // the findings that matter.
    const schemaBacked = screen.controls.some(
      (control) => control.testId && declared.has(control.testId),
    );
    if (!schemaBacked) continue;

    for (const control of screen.controls) {
      if (!control.testId) continue;
      if (NON_FIELD_CONTROLS.has(control.tag)) continue;
      if (!control.inForm) continue;
      if (declared.has(control.testId)) continue;
      findings.push({
        kind: "control-without-rule",
        subject: `${screen.route} -> ${control.testId}`,
        detail:
          `Screen renders an input "${control.testId}" inside a schema-backed form, ` +
          `but no declared schema field covers it. It may be unvalidated.`,
      });
    }
  }

  return findings;
}
