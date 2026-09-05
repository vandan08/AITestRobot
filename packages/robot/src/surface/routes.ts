import { Node, Project, SyntaxKind } from "ts-morph";
import type { JsxAttribute, JsxSelfClosingElement, JsxElement } from "ts-morph";
import type { SurfaceEndpoint, SurfaceRoute } from "../types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function project(globs: string[]): Project {
  const p = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { jsx: 4 /* react-jsx */ },
  });
  p.addSourceFilesAtPaths(globs);
  return p;
}

function attributeText(
  element: JsxSelfClosingElement | JsxElement,
  name: string,
): string | undefined {
  const opening = Node.isJsxSelfClosingElement(element)
    ? element
    : element.getOpeningElement();
  const attribute = opening.getAttribute(name);
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;

  const initializer = (attribute as JsxAttribute).getInitializer();
  if (!initializer) return undefined;
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralValue();
  if (Node.isJsxExpression(initializer)) {
    return initializer.getExpression()?.getText();
  }
  return undefined;
}

/** The first component name mentioned in an `element={...}` expression. */
function componentOf(raw: string | undefined): string {
  if (!raw) return "unknown";
  const match = raw.match(/<([A-Z][A-Za-z0-9_]*)/);
  return match ? match[1] : raw.slice(0, 40);
}

export function extractRoutes(globs: string[]): SurfaceRoute[] {
  const routes: SurfaceRoute[] = [];

  for (const file of project(globs).getSourceFiles()) {
    const elements = [
      ...file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
      ...file.getDescendantsOfKind(SyntaxKind.JsxElement),
    ];

    for (const element of elements) {
      const tag = Node.isJsxSelfClosingElement(element)
        ? element.getTagNameNode().getText()
        : element.getOpeningElement().getTagNameNode().getText();
      if (tag !== "Route") continue;

      const path = attributeText(element, "path");
      if (!path) continue;

      routes.push({
        path,
        component: componentOf(attributeText(element, "element")),
        source: `${file.getBaseName()}:${element.getStartLineNumber()}`,
      });
    }
  }

  return routes;
}

export function extractEndpoints(globs: string[]): SurfaceEndpoint[] {
  const endpoints: SurfaceEndpoint[] = [];

  for (const file of project(globs).getSourceFiles()) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;

      const method = expression.getName().toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;

      const receiver = expression.getExpression().getText();
      if (!/^(app|router|api)$/.test(receiver)) continue;

      const first = call.getArguments()[0];
      if (!first || !Node.isStringLiteral(first)) continue;

      endpoints.push({
        method: method.toUpperCase(),
        path: first.getLiteralValue(),
        source: `${file.getBaseName()}:${call.getStartLineNumber()}`,
      });
    }
  }

  return endpoints;
}
