import type { Estree } from "../codemod/ast.ts";

import { child, nameOf, nodes, walk } from "../codemod/ast.ts";

/** What `resolveConfigRoot` found in one module. */
export interface ConfigRoots {
  /**
   * Object literals handed to PermDock's `defineConfig` or exported as the
   * config.
   */
  readonly roots: readonly Estree[];
  /** Values the resolver could not follow, with where they sit. */
  readonly unresolved: readonly { readonly at: number; readonly why: string }[];
}

const PERMDOCK = /^permdock(?:\/|$)/u;

/**
 * The local names `defineConfig` has in this module, and the namespaces that
 * hold it.
 */
function definers(program: Estree): {
  readonly names: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
} {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of nodes(program.body)) {
    const from = statement.source?.value;
    if (
      statement.type !== "ImportDeclaration" ||
      typeof from !== "string" ||
      !PERMDOCK.test(from)
    ) {
      continue;
    }
    for (const specifier of nodes(statement.specifiers)) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        namespaces.add(nameOf(specifier.local) ?? "");
      } else if (
        specifier.type === "ImportSpecifier" &&
        nameOf(specifier.imported) === "defineConfig"
      ) {
        names.add(nameOf(specifier.local) ?? "defineConfig");
      }
    }
  }
  return { names, namespaces };
}

function topLevelConst(program: Estree, name: string): Estree | undefined {
  for (const statement of nodes(program.body)) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") {
      continue;
    }
    for (const item of nodes(declaration.declarations)) {
      if (
        nameOf(item.id) === name &&
        item.init !== null &&
        item.init !== undefined
      ) {
        return item.init;
      }
    }
  }
  return undefined;
}

function returned(fn: Estree): Estree | undefined {
  const body = child(fn, "body");
  if (body?.type !== "BlockStatement") {
    return body;
  }
  const last = nodes(body.body).findLast(
    (statement) => statement.type === "ReturnStatement",
  );
  return last?.argument ?? undefined;
}

/**
 * The config object literals of a module. It follows `satisfies`, `as`,
 * parentheses, `const config = {...}; export default config`, a
 * default-exported function's return, `module.exports`, a namespace call
 * (`p.defineConfig`) and an aliased import. `defineConfig` counts only when
 * imported from `permdock`, so another tool's `defineConfig` is never
 * rewritten.
 */
export function resolveConfigRoot(
  program: Estree,
  options: { readonly isConfigFile: boolean },
): ConfigRoots {
  const { names, namespaces } = definers(program);
  const roots: Estree[] = [];
  const unresolved: { at: number; why: string }[] = [];
  const seen = new Set<Estree>();

  const isDefine = (callee: Estree | undefined): boolean => {
    if (callee?.type === "Identifier") {
      return names.has(callee.name ?? "");
    }
    return (
      callee?.type === "MemberExpression" &&
      callee.object?.type === "Identifier" &&
      namespaces.has(callee.object.name ?? "") &&
      nameOf(callee.property) === "defineConfig"
    );
  };

  const follow = (node: Estree | null | undefined, depth: number): void => {
    if (node === null || node === undefined || depth > 8 || seen.has(node)) {
      return;
    }
    seen.add(node);
    switch (node.type) {
      case "ObjectExpression": {
        roots.push(node);
        for (const property of nodes(node.properties)) {
          if (property.type === "SpreadElement") {
            unresolved.push({
              at: property.start,
              why: "a spread in the config object is not followed",
            });
          }
        }
        return;
      }
      case "TSSatisfiesExpression":
      case "TSAsExpression":
      case "TSNonNullExpression":
      case "ParenthesizedExpression":
        follow(child(node, "expression"), depth + 1);
        return;
      case "CallExpression":
        if (isDefine(node.callee)) {
          follow(node.arguments?.[0], depth + 1);
        } else {
          unresolved.push({
            at: node.start,
            why: "the exported value is a call other than PermDock's defineConfig",
          });
        }
        return;
      case "Identifier": {
        const init = topLevelConst(program, node.name ?? "");
        if (init === undefined) {
          unresolved.push({
            at: node.start,
            why: `${node.name ?? "the value"} is not a const of this module`,
          });
        } else {
          follow(init, depth + 1);
        }
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        follow(returned(node), depth + 1);
        return;
      default:
        unresolved.push({
          at: node.start,
          why: `a ${node.type} is not followed`,
        });
    }
  };

  walk(program, (node) => {
    if (node.type === "CallExpression" && isDefine(node.callee)) {
      follow(node, 0);
    } else if (
      node.type === "ExportDefaultDeclaration" &&
      options.isConfigFile
    ) {
      follow(node.declaration, 0);
    } else if (
      options.isConfigFile &&
      node.type === "AssignmentExpression" &&
      node.left?.type === "MemberExpression" &&
      nameOf(node.left.object) === "module" &&
      nameOf(node.left.property) === "exports"
    ) {
      follow(node.right, 0);
    }
  });
  return { roots, unresolved };
}
