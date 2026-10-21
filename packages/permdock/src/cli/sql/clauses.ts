import type { GrantValidity } from "../../core/policy-types.ts";
import type { CompiledBranch } from "./compile.ts";

/**
 * True when `sql` is one parenthesised expression, so AND / OR need not wrap it
 * again.
 */
function isWrapped(sql: string): boolean {
  if (!sql.startsWith("(") || !sql.endsWith(")")) {
    return false;
  }
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const ch = sql[index];
    if (ch === "'") {
      quoted = !quoted;
    } else if (!quoted && ch === "(") {
      depth += 1;
    } else if (!quoted && ch === ")") {
      depth -= 1;
      if (depth === 0 && index < sql.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

export function wrapSql(sql: string): string {
  return isWrapped(sql) ? sql : `(${sql})`;
}

/**
 * The grant's `validFrom` / `validUntil` as a clock check: `from` inclusive,
 * `until` exclusive, matching the in-process evaluator.
 */
export function validitySql(
  validity: GrantValidity | undefined,
): string | undefined {
  if (validity === undefined) {
    return undefined;
  }
  return andSql(
    validity.from === undefined
      ? undefined
      : `now() >= to_timestamp(${validity.from})`,
    validity.until === undefined
      ? undefined
      : `now() < to_timestamp(${validity.until})`,
  );
}

export function andSql(
  ...parts: readonly (string | undefined)[]
): string | undefined {
  const present = parts.filter(
    (part): part is string => part !== undefined && part !== "true",
  );
  if (present.length === 0) {
    return undefined;
  }
  return present.length === 1 ? present[0] : present.map(wrapSql).join(" and ");
}

/**
 * `USING` and `WITH CHECK` for a branch: its access check ANDed with its row
 * conditions.
 */
export function branchClauses(branch: CompiledBranch): {
  readonly using?: string;
  readonly check?: string;
} {
  const using =
    branch.command === "insert"
      ? undefined
      : (andSql(branch.access, branch.using) ?? "true");
  const check =
    branch.command === "insert" || branch.command === "update"
      ? (andSql(branch.access, branch.check) ?? "true")
      : undefined;
  return {
    ...(using === undefined ? {} : { using }),
    ...(check === undefined ? {} : { check }),
  };
}
