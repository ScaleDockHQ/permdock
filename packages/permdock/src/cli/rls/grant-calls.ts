import type { SqlClient } from "../pg.ts";

/**
 * A helper call that names a permission key: `permdock_has('post.read')`,
 * `permitted_organization_ids('post.read')`, `can_post(id, 'post.read')`. The
 * key is the first quoted literal that looks like `resource.action`.
 */
const GRANT_CALL =
  /\b(?:permdock_has\w*|permitted_\w+|can_\w+)\s*\(\s*(?:[^,'()]*,\s*)*'([a-z][a-z0-9_]*\.[a-z0-9_.#@]+)'/giu;

export type GrantCall = {
  readonly key: string;
  /** Executions summed over every normalised statement that names the key. */
  readonly calls: number;
  /** Distinct statements that name the key. */
  readonly statements: number;
};

export type GrantCalls =
  | { readonly available: true; readonly keys: readonly GrantCall[] }
  | { readonly available: false; readonly reason: string };

/** The keys one statement names, once each. */
export function keysIn(statement: string): readonly string[] {
  return [
    ...new Set(
      [...statement.matchAll(GRANT_CALL)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    ),
  ];
}

/**
 * Executions per permission key from `pg_stat_statements`. Postgres keeps no
 * per-argument counts for a function, so the count is that of the statements
 * whose text names the key, most-called first.
 */
export async function grantCalls(client: SqlClient): Promise<GrantCalls> {
  let rows: Record<string, unknown>[];
  try {
    rows = (
      await client.query(
        "select query, calls::text as calls from pg_stat_statements",
        [],
      )
    ).rows;
  } catch {
    return {
      available: false,
      reason:
        "pg_stat_statements is not readable: run create extension pg_stat_statements and let the app run",
    };
  }
  const byKey = new Map<string, { calls: number; statements: number }>();
  for (const row of rows) {
    const query = row["query"];
    const calls = Number(row["calls"]);
    if (typeof query !== "string" || !Number.isFinite(calls)) {
      continue;
    }
    for (const key of keysIn(query)) {
      const found = byKey.get(key) ?? { calls: 0, statements: 0 };
      byKey.set(key, {
        calls: found.calls + calls,
        statements: found.statements + 1,
      });
    }
  }
  return {
    available: true,
    keys: [...byKey]
      .map(([key, value]) => ({ key, ...value }))
      .toSorted((a, b) => b.calls - a.calls || a.key.localeCompare(b.key)),
  };
}

/** The lines `rls verify --advisors --grant-calls` prints after the findings. */
export function grantCallLines(result: GrantCalls): readonly string[] {
  if (!result.available) {
    return [`grant calls: ${result.reason}`];
  }
  if (result.keys.length === 0) {
    return [
      "grant calls: no statement in pg_stat_statements names a permission key",
    ];
  }
  return [
    "grant calls (executions of statements that name the key, from pg_stat_statements):",
    ...result.keys
      .slice(0, 20)
      .map(
        (item) =>
          `  ${String(item.calls).padStart(9)}  ${item.key} (${String(item.statements)} statement${item.statements === 1 ? "" : "s"})`,
      ),
  ];
}
