import type { Estree } from "../codemod/ast.ts";
import type { DoctorFinding, DoctorSource } from "../shared/doctor-types.ts";

import { nameOf, walk } from "../codemod/ast.ts";
import { parseSync } from "../core/optional.ts";

/** Options that give an instance its own cache or membership source. */
const OWN_OPTIONS: ReadonlySet<string> = new Set([
  "memberships",
  "customRoles",
  "versions",
  "instances",
]);

const BUILDERS: ReadonlySet<string> = new Set([
  "createPermDock",
  "getPermDock",
]);

type Site = {
  readonly file: string;
  readonly line: number;
  readonly own: string[];
};

function sitesOf(source: DoctorSource): {
  readonly usesFor: boolean;
  readonly builders: readonly Site[];
} {
  const parsed = parseSync(source.file, source.text);
  const failed = parsed.errors.some((error) => {
    // `Severity` is an ambient const enum, which isolated modules cannot reference.
    const severity: string = error.severity;
    return severity === "Error";
  });
  if (failed) {
    return { usesFor: false, builders: [] };
  }
  let usesFor = false;
  const builders: Site[] = [];
  // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
  const program = parsed.program as unknown as Estree;
  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = node.callee;
    const name =
      callee?.type === "MemberExpression"
        ? nameOf(callee.property)
        : nameOf(callee);
    if (name === "permdockFor") {
      usesFor = true;
      return;
    }
    if (name === undefined || !BUILDERS.has(name)) {
      return;
    }
    const own = (node.arguments ?? []).flatMap((argument) =>
      (argument.type === "ObjectExpression" ? (argument.properties ?? []) : [])
        .map((property) => nameOf(property.key))
        .filter(
          (key): key is string => key !== undefined && OWN_OPTIONS.has(key),
        ),
    );
    if (own.length > 0) {
      builders.push({
        file: source.file,
        line: source.text.slice(0, node.start).split("\n").length,
        own,
      });
    }
  });
  return { usesFor, builders };
}

/**
 * PD130: the project calls `permdockFor` and also builds an instance with
 * `getPermDock` or `createPermDock` and its own `memberships`, `customRoles`,
 * `versions` or `instances`. That instance misses the `instanceCache` entry and
 * the version cache `permdockFor` shares, so one request reads the
 * authorization version twice.
 */
export function pd130(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const found = sources.map(sitesOf);
  if (!found.some((entry) => entry.usesFor)) {
    return [];
  }
  return found.flatMap((entry) =>
    entry.builders.map(({ file, line, own }) => ({
      code: "PD130",
      severity: "warning" as const,
      target: `${file}:${String(line)}`,
      message: `${file}:${String(line)} builds an instance with its own ${own.join(", ")} while the project also calls permdockFor, so it never shares permdockFor's instance cache or version cache and reads the authorization version again`,
      fix: "spread permdockFor.sources() into the options, or resolve the instance with permdockFor(claims, { tenant, intent })",
    })),
  );
}
