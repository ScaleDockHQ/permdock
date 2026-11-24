import { basename } from "node:path";

import type { Estree } from "../codemod/ast.ts";

import { child, nodes } from "../codemod/ast.ts";
import { parseSync } from "../core/optional.ts";
import { resolveConfigRoot } from "./config-root.ts";
import { propertyKey } from "./edits.ts";

function propertyAt(
  root: Estree,
  path: readonly string[],
): { readonly object: Estree; readonly property: Estree } | undefined {
  let object = root;
  for (const [index, key] of path.entries()) {
    const property = nodes(object.properties).find(
      (item) => propertyKey(item) === key,
    );
    if (property === undefined) {
      return undefined;
    }
    if (index === path.length - 1) {
      return { object, property };
    }
    const value = child(property, "value");
    if (value?.type !== "ObjectExpression") {
      return undefined;
    }
    object = value;
  }
  return undefined;
}

/**
 * The object literal property at `path` under a config root of `text`, with the
 * object that holds it; `undefined` when the key comes from a call, a spread or
 * an import rather than the file's own literal.
 */
export function configProperty(
  file: string,
  text: string,
  path: readonly string[],
): { readonly object: Estree; readonly property: Estree } | undefined {
  const parsed = parseSync(file, text, { sourceType: "module" });
  // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
  const program = parsed.program as unknown as Estree;
  const roots = resolveConfigRoot(program, {
    isConfigFile: basename(file).startsWith("permdock.config."),
  }).roots;
  return roots
    .map((root) => propertyAt(root, path))
    .find((item) => item !== undefined);
}

/** The paths the config file writes as object literal keys. */
export function writtenPaths(
  file: string,
  text: string,
  paths: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  return paths.filter((path) => configProperty(file, text, path) !== undefined);
}
