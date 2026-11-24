import type { Estree } from "../codemod/ast.ts";

import { nameOf, walk } from "../codemod/ast.ts";
import { parseSync } from "../core/optional.ts";

/**
 * The names `text` calls: `f()` gives `f`, `a.b.c()` gives `c`. Comments and
 * strings never count, so `// nativeRefresh()` calls nothing. A file that does
 * not parse calls nothing.
 */
export function calledNames(file: string, text: string): ReadonlySet<string> {
  const parsed = parseSync(file, text);
  const names = new Set<string>();
  // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
  const program = parsed.program as unknown as Estree;
  const failed = parsed.errors.some((error) => {
    // `Severity` is an ambient const enum, which isolated modules cannot reference.
    const severity: string = error.severity;
    return severity === "Error";
  });
  if (failed) {
    return names;
  }
  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = node.callee;
    const name =
      callee?.type === "MemberExpression"
        ? nameOf(callee.property)
        : nameOf(callee);
    if (name !== undefined) {
      names.add(name);
    }
  });
  return names;
}
