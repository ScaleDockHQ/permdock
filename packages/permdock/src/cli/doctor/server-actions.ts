import type { DoctorFinding, DoctorSource } from "../shared/doctor-types.ts";

const DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use server['"]/u;
const EXPORT =
  /^export\s+(?:default\s+)?(?:async\s+function\s*\*?\s*(\w+)|const\s+(\w+)\s*=)/gmu;
const GUARD =
  /\b(?:protectAction|requirePermission|getPermission)\s*\(|\.assert\s*\(/u;

/**
 * PD116: a module with a file-level `'use server'` exports a Server Action that
 * never calls `protectAction`, `requirePermission`, `getPermission` or
 * `assert`. Every export of such a module is a public POST endpoint.
 */
export function pd116(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (!DIRECTIVE.test(source.text)) {
      continue;
    }
    const exports = [...source.text.matchAll(EXPORT)];
    for (const [index, match] of exports.entries()) {
      const name = match[1] ?? match[2] ?? "default";
      const start = match.index;
      const end = exports[index + 1]?.index ?? source.text.length;
      if (GUARD.test(source.text.slice(start, end))) {
        continue;
      }
      const line = source.text.slice(0, start).split("\n").length;
      findings.push({
        code: "PD116",
        severity: "warning",
        target: `${source.file}:${String(line)}`,
        message: `Server Action ${name} at ${source.file}:${String(line)} is exported from a 'use server' module and checks no permission: anyone who can reach the page can POST to it`,
        fix: "wrap it with protectAction(permission, { input })(handler), or call requirePermission(permission, data) first",
      });
    }
  }
  return findings;
}
