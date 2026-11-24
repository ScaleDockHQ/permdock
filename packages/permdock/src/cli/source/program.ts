import type { Estree } from "../codemod/ast.ts";

import { parseSync } from "../core/optional.ts";

/** The program of `text`, or `undefined` when the parser reports an error. */
export function parseProgram(file: string, text: string): Estree | undefined {
  const parsed = parseSync(file, text);
  const failed = parsed.errors.some((error) => {
    // `Severity` is an ambient const enum, which isolated modules cannot reference.
    const severity: string = error.severity;
    return severity === "Error";
  });
  // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
  return failed ? undefined : (parsed.program as unknown as Estree);
}
