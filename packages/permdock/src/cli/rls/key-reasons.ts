import type { Policy } from "../../index.ts";
import type { PermDockConfig } from "../types.ts";

import { CliError } from "../core/errors.ts";
import { compileGrants } from "../sql/compile.ts";
import { tableNames } from "../sql/tables.ts";
import { buildContext } from "./generate-context.ts";
import { generateOptions, isRefusal } from "./generate-options.ts";

/**
 * The keys whose `permitted_<scope>_ids_by_permission(k)` answers what
 * `permitted_<scope>_ids(k)` answers, and for every other key the first grant
 * that makes them differ.
 */
export type KeyReasons = {
  readonly swappable: ReadonlySet<string>;
  /** Key to the grant that keeps it off the tag, as one sentence. */
  readonly reasons: ReadonlyMap<string, string>;
};

type Row = {
  readonly role: string;
  readonly permission: string;
  readonly grantKey: string;
  readonly scope: string;
  readonly effect: "allow" | "deny";
};

/** A grant key written as a condition group (`k#1`) or a level (`k@own`). */
function isConditionKey(permission: string, grantKey: string): boolean {
  return (
    grantKey.startsWith(`${permission}#`) ||
    grantKey.startsWith(`${permission}@`)
  );
}

/** Why `row` is not an unconditional allow of its own key, or `undefined`. */
function whyNot(
  row: Row,
  conditioned: ReadonlySet<string>,
): string | undefined {
  const holder = `role ${row.role} on ${row.scope}`;
  if (row.effect === "deny") {
    return `${holder} denies it`;
  }
  if (row.grantKey !== row.permission) {
    return isConditionKey(row.permission, row.grantKey)
      ? `${holder} grants it under a condition (grant key ${row.grantKey})`
      : `${holder} grants it through another key (${row.grantKey})`;
  }
  if (conditioned.has(row.grantKey)) {
    return `${holder} grants it under a row condition or a validity window`;
  }
  return undefined;
}

/**
 * Reads the compiled grants of `policy` and sorts each permission key into the
 * ones the by-permission helper answers like the plain one, and the ones it
 * does not, with the first grant that decides it.
 */
export function keyReasons(
  config: PermDockConfig,
  policy: Policy,
  cwd: string,
): KeyReasons {
  const generate = {
    cwd,
    config,
    target: "sql",
    dialect: config.rls?.dialect ?? "supabase",
    rbac: false,
    check: false,
    skipClosures: true,
    inlineFunctions: false,
    io: { stdout: () => undefined, stderr: () => undefined },
  } as const;
  const options = generateOptions(generate);
  if (isRefusal(options)) {
    throw new CliError("usage", options.refusal, { code: "invalid_value" });
  }
  const built = buildContext(generate, policy, options);
  if (isRefusal(built)) {
    throw new CliError("usage", built.refusal, { code: "invalid_value" });
  }
  const compiled = compileGrants(
    policy,
    built.ctx,
    tableNames(config.rls?.tables),
    [],
    true,
  );
  const found = new Map<
    string,
    { count: number; first: string; deny: boolean }
  >();
  const ok = new Set<string>();
  for (const row of compiled.rolePermissions) {
    ok.add(row.permission);
    const why = whyNot(row, compiled.conditionedKeys);
    if (why === undefined) {
      continue;
    }
    // A deny moves the allows of the key into condition groups, so it is the cause.
    const entry = found.get(row.permission);
    const replace =
      entry === undefined || (row.effect === "deny" && !entry.deny);
    found.set(row.permission, {
      count: (entry?.count ?? 0) + 1,
      first: replace ? why : entry.first,
      deny: replace ? row.effect === "deny" : entry.deny,
    });
  }
  const reasons = new Map(
    [...found].map(([key, { count, first }]) => [
      key,
      count === 1 ? first : `${first}; ${String(count - 1)} more grants differ`,
    ]),
  );
  return {
    swappable: new Set([...ok].filter((key) => !reasons.has(key))),
    reasons,
  };
}

/** The sentence for `key`, which `reasons` may not know. */
export function keyReason(reasons: KeyReasons, key: string): string {
  return (
    reasons.reasons.get(key) ??
    (reasons.swappable.has(key)
      ? "every grant of it is unconditional; permdock codemod bsb-access-tags moves the policy unless another policy or tenant column on the table prevents it"
      : "the policy declares no grant of it")
  );
}

/** `keyReasons`, or `undefined` for a policy or config the generator refuses. */
export function tryKeyReasons(
  config: PermDockConfig,
  policy: Policy,
  cwd: string,
): KeyReasons | undefined {
  try {
    return keyReasons(config, policy, cwd);
  } catch (error) {
    if (error instanceof CliError) {
      return undefined;
    }
    throw error;
  }
}
