import { Node, Project, SyntaxKind } from "ts-morph";
import type { CallExpression, SourceFile, VariableDeclaration } from "ts-morph";
import type { FieldRule, Refinement, SurfaceField, SurfaceSchema } from "../types.js";

/**
 * Reads validation rules straight off the zod chains in the source.
 *
 * This is deliberately not a model's job. A model handed a repo produces a plausible
 * inventory that is quietly missing fields; an AST walk produces a complete one. Stage 2
 * reasons over the result — it does not go looking for it.
 */

interface ChainLink {
  name: string;
  args: Node[];
}

/** Flatten `z.string().min(2).optional()` into base + ordered links. */
function flattenChain(node: Node): { base: string; links: ChainLink[] } | undefined {
  const links: ChainLink[] = [];
  let current: Node = node;

  while (Node.isCallExpression(current)) {
    const expression = (current as CallExpression).getExpression();
    if (!Node.isPropertyAccessExpression(expression)) break;
    links.push({
      name: expression.getName(),
      args: (current as CallExpression).getArguments(),
    });
    current = expression.getExpression();
  }

  if (links.length === 0) return undefined;
  // The chain was walked outermost-first; the last link is the base type call.
  links.reverse();
  const base = links.shift()!;
  return { base: base.name, links: [{ name: base.name, args: base.args }, ...links] };
}

function literalText(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  return undefined;
}

/** zod messages are either a bare string or `{ message: "..." }`. */
function messageOf(args: Node[], index: number): string | undefined {
  const arg = args[index];
  if (!arg) return undefined;
  const direct = literalText(arg);
  if (direct !== undefined) return direct;
  if (Node.isObjectLiteralExpression(arg)) {
    const prop = arg.getProperty("message");
    if (prop && Node.isPropertyAssignment(prop)) {
      return literalText(prop.getInitializer());
    }
  }
  return undefined;
}

/** Resolve `ROLES` back to its `[...] as const` members. */
function resolveStringArray(node: Node, file: SourceFile): string[] | undefined {
  let target: Node | undefined = node;

  if (Node.isIdentifier(node)) {
    const declaration = file.getVariableDeclaration(node.getText());
    target = declaration?.getInitializer();
    if (target && Node.isAsExpression(target)) target = target.getExpression();
  }
  if (target && Node.isAsExpression(target)) target = target.getExpression();
  if (!target || !Node.isArrayLiteralExpression(target)) return undefined;

  const members = target
    .getElements()
    .map((element) => literalText(element))
    .filter((value): value is string => value !== undefined);
  return members.length > 0 ? members : undefined;
}

function where(node: Node): string {
  const file = node.getSourceFile();
  return `${file.getBaseName()}:${node.getStartLineNumber()}`;
}

function readField(name: string, initializer: Node, file: SourceFile): SurfaceField {
  const chain = flattenChain(initializer);
  const rules: FieldRule[] = [];
  let optional = false;
  let type: SurfaceField["type"] = "unknown";

  if (!chain) {
    return { name, type, optional, rules };
  }

  for (const link of chain.links) {
    const source = where(initializer);
    switch (link.name) {
      case "string":
        type = "string";
        rules.push({ kind: "type", value: "string", source });
        break;
      case "number":
        type = "number";
        rules.push({ kind: "type", value: "number", source });
        break;
      case "boolean":
        type = "boolean";
        rules.push({ kind: "type", value: "boolean", source });
        break;
      case "enum": {
        type = "enum";
        const members = link.args[0]
          ? resolveStringArray(link.args[0], file)
          : undefined;
        rules.push({
          kind: "enum",
          value: members ?? [],
          message: messageOf(link.args, 1),
          source,
        });
        break;
      }
      case "min": {
        const bound = Number(link.args[0]?.getText());
        rules.push({
          kind: "min",
          value: Number.isNaN(bound) ? link.args[0]?.getText() : bound,
          message: messageOf(link.args, 1),
          source,
        });
        break;
      }
      case "max": {
        const bound = Number(link.args[0]?.getText());
        rules.push({
          kind: "max",
          value: Number.isNaN(bound) ? link.args[0]?.getText() : bound,
          message: messageOf(link.args, 1),
          source,
        });
        break;
      }
      case "email":
        rules.push({ kind: "email", message: messageOf(link.args, 0), source });
        break;
      case "regex": {
        const raw = link.args[0]?.getText() ?? "";
        rules.push({
          kind: "regex",
          value: raw,
          message: messageOf(link.args, 1),
          source,
        });
        break;
      }
      case "optional":
      case "nullish":
        optional = true;
        rules.push({ kind: "optional", source });
        break;
      default:
        break;
    }
  }

  if (!optional) {
    rules.unshift({ kind: "required", source: where(initializer) });
  }
  return { name, type, optional, rules };
}

/**
 * Cross-field rules live in `.superRefine`. We do not try to interpret the logic —
 * we capture the guard verbatim and hand it to Stage 2, which reads code fine.
 */
function readRefinements(chainRoot: Node): Refinement[] {
  const found: Refinement[] = [];

  chainRoot.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expression = node.getExpression();
    if (
      !Node.isPropertyAccessExpression(expression) ||
      expression.getName() !== "addIssue"
    ) {
      return;
    }

    const arg = node.getArguments()[0];
    if (!arg || !Node.isObjectLiteralExpression(arg)) return;

    const pathProp = arg.getProperty("path");
    const messageProp = arg.getProperty("message");

    let field = "_";
    if (pathProp && Node.isPropertyAssignment(pathProp)) {
      const initializer = pathProp.getInitializer();
      if (initializer && Node.isArrayLiteralExpression(initializer)) {
        field = literalText(initializer.getElements()[0]) ?? "_";
      }
    }

    let message = "";
    if (messageProp && Node.isPropertyAssignment(messageProp)) {
      const initializer = messageProp.getInitializer();
      message =
        literalText(initializer) ??
        initializer?.getText().replace(/\s+/g, " ").trim() ??
        "";
    }

    const guard = node.getFirstAncestorByKind(SyntaxKind.IfStatement);
    const condition = guard
      ? guard.getExpression().getText().replace(/\s+/g, " ").trim()
      : "(unconditional)";

    found.push({ field, message, condition, source: where(node) });
  });

  return found;
}

function isZodObjectChain(node: Node | undefined): boolean {
  if (!node) return false;
  let current: Node = node;
  while (Node.isCallExpression(current)) {
    const expression = current.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) return false;
    if (
      expression.getName() === "object" &&
      expression.getExpression().getText() === "z"
    ) {
      return true;
    }
    current = expression.getExpression();
  }
  return false;
}

/** Walk down a chain to the `z.object({...})` call at its root. */
function findObjectLiteral(node: Node): Node | undefined {
  let current: Node = node;
  while (Node.isCallExpression(current)) {
    const expression = current.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) return undefined;
    if (
      expression.getName() === "object" &&
      expression.getExpression().getText() === "z"
    ) {
      return current.getArguments()[0];
    }
    current = expression.getExpression();
  }
  return undefined;
}

export function extractSchemas(globs: string[]): SurfaceSchema[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  project.addSourceFilesAtPaths(globs);

  const schemas: SurfaceSchema[] = [];

  for (const file of project.getSourceFiles()) {
    for (const declaration of file.getVariableDeclarations() as VariableDeclaration[]) {
      const initializer = declaration.getInitializer();
      if (!isZodObjectChain(initializer)) continue;

      const objectLiteral = findObjectLiteral(initializer!);
      if (!objectLiteral || !Node.isObjectLiteralExpression(objectLiteral)) continue;

      const fields: SurfaceField[] = [];
      for (const property of objectLiteral.getProperties()) {
        if (!Node.isPropertyAssignment(property)) continue;
        const value = property.getInitializer();
        if (!value) continue;
        fields.push(readField(property.getName(), value, file));
      }

      schemas.push({
        name: declaration.getName(),
        file: file.getFilePath(),
        fields,
        refinements: readRefinements(initializer!),
      });
    }
  }

  return schemas;
}
