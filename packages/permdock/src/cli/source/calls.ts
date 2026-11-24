import { nameOf, walk } from "../codemod/ast.ts";
import { parseProgram } from "./program.ts";

/**
 * The names `text` calls: `f()` gives `f`, `a.b.c()` gives `c`. Comments and
 * strings never count, so `// nativeRefresh()` calls nothing. A file that does
 * not parse calls nothing.
 */
export function calledNames(file: string, text: string): ReadonlySet<string> {
  const names = new Set<string>();
  const program = parseProgram(file, text);
  if (program === undefined) {
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
