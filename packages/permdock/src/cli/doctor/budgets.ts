import type { Estree } from "../codemod/ast.ts";
import type { Project } from "../project/project.ts";
import type { DoctorFinding, DoctorSource } from "../shared/doctor-types.ts";

import { breachText, budgetBreaches } from "../budgets/budgets.ts";
import { nameOf, walk } from "../codemod/ast.ts";
import { parseSync } from "../core/optional.ts";

/** PD132: the policy is over a budget in `budgets`. */
export async function pd132(
  project: Pick<Project, "policy" | "config">,
): Promise<readonly DoctorFinding[]> {
  if (project.config.budgets === undefined) {
    return [];
  }
  const policy = await project.policy();
  if (policy === undefined) {
    return [];
  }
  return budgetBreaches(policy, project.config).map((breach) => ({
    code: "PD132",
    severity: "error",
    target: `budgets.${breach.budget}`,
    message: breachText(breach),
    fix:
      breach.budget === "claims"
        ? "narrow the roles each membership carries, or raise budgets.claims; `permdock claims size` lists the cut"
        : `narrow the largest part or raise budgets.${breach.budget}; \`permdock ${breach.budget === "bundle" ? "bundle" : "snapshot"} size\` lists the parts`,
  }));
}

function isPermDockModule(specifier: unknown): boolean {
  return (
    typeof specifier === "string" &&
    (specifier === "permdock" || specifier.startsWith("permdock/"))
  );
}

function isUseClient(program: Estree): boolean {
  const body = Array.isArray(program.body) ? program.body : [];
  return body.some(
    (statement: Estree) => Reflect.get(statement, "directive") === "use client",
  );
}

/** The JSX attribute's name and its `{expression}`, when it has one. */
function jsxAttribute(
  node: Estree,
): { readonly name: string; readonly expression: Estree } | undefined {
  const name: unknown = Reflect.get(node, "name");
  const value: unknown = Reflect.get(node, "value");
  if (typeof name !== "object" || name === null) {
    return undefined;
  }
  const label: unknown = Reflect.get(name, "name");
  if (
    typeof label !== "string" ||
    typeof value !== "object" ||
    value === null
  ) {
    return undefined;
  }
  const expression: unknown = Reflect.get(value, "expression");
  if (typeof expression !== "object" || expression === null) {
    return undefined;
  }
  // SAFETY: an Oxc JSXExpressionContainer's expression is an ESTree node.
  return { name: label, expression: expression as Estree };
}

function passedBundles(source: DoctorSource): readonly number[] {
  const parsed = parseSync(source.file, source.text);
  const failed = parsed.errors.some((error) => {
    // `Severity` is an ambient const enum, which isolated modules cannot reference.
    const severity: string = error.severity;
    return severity === "Error";
  });
  if (failed) {
    return [];
  }
  // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
  const program = parsed.program as unknown as Estree;
  if (isUseClient(program)) {
    return [];
  }
  const builders = new Set<string>();
  walk(program, (node) => {
    if (
      node.type !== "ImportDeclaration" ||
      !isPermDockModule(node.source?.value)
    ) {
      return;
    }
    for (const specifier of node.specifiers ?? []) {
      if (nameOf(specifier.imported) === "clientBundle") {
        const local = nameOf(specifier.local);
        if (local !== undefined) {
          builders.add(local);
        }
      }
    }
  });
  if (builders.size === 0) {
    return [];
  }
  const isBuild = (node: Estree | null | undefined): boolean =>
    node?.type === "CallExpression" && builders.has(nameOf(node.callee) ?? "");
  const bound = new Set<string>();
  walk(program, (node) => {
    if (node.type === "VariableDeclarator" && isBuild(node.init)) {
      const name = nameOf(node.id);
      if (name !== undefined) {
        bound.add(name);
      }
    }
  });
  const lines: number[] = [];
  walk(program, (node) => {
    if (node.type !== "JSXAttribute") {
      return;
    }
    const attribute = jsxAttribute(node);
    if (attribute?.name !== "bundle") {
      return;
    }
    const { expression } = attribute;
    const passed =
      isBuild(expression) ||
      (expression.type === "Identifier" && bound.has(expression.name ?? ""));
    if (passed) {
      lines.push(source.text.slice(0, node.start).split("\n").length);
    }
  });
  return lines;
}

/**
 * PD133: a server module calls `clientBundle(policy)` and passes the result to
 * a provider's `bundle` prop. The provider is a client component, so React
 * serialises the bundle into every document that renders it.
 */
export function pd133(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  return sources.flatMap((source) =>
    passedBundles(source).map((line) => ({
      code: "PD133",
      severity: "warning" as const,
      target: `${source.file}:${String(line)}`,
      message: `${source.file}:${String(line)} builds clientBundle(policy) in a server module and passes it as the bundle prop, so every document that renders the provider carries the whole bundle`,
      fix: 'generate the bundle with `permdock gen --kind bundle` and pass the clientBundle export of its "use client" module, which reaches the browser as a reference',
    })),
  );
}
