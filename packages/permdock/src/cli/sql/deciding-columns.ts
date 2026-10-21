import type { PermDockConfig, SupabaseHookConfig } from "../types.ts";

import { membershipSourcesOf } from "./sources.ts";

/** `schema.table`, unquoted and lower case; `public` when unqualified. */
export function tableKey(name: string): string {
  const parts = name.split(".").map((part) => part.replaceAll('"', ""));
  return (parts.length === 1 ? ["public", ...parts] : parts)
    .join(".")
    .toLowerCase();
}

/**
 * The columns of each membership source's table that decide who holds which
 * membership (user, scope, id, `within`, role, `via`, expiry), and the id and
 * value columns of a table a role or user column references, keyed by
 * {@link tableKey}. A client that can write one can give itself a membership.
 * The hook's sources count even when `rls.membershipSources` replaces them for
 * the helpers: the token's claims still come from them.
 */
export function membershipColumns(
  config: PermDockConfig,
): ReadonlyMap<string, ReadonlySet<string>> {
  const sources = new Set([
    ...membershipSourcesOf(config),
    ...(config.supabase?.hook?.memberships ?? []),
  ]);
  const byTable = new Map<string, Set<string>>();
  for (const source of sources) {
    const table = tableKey(source.sql.table);
    const columns = byTable.get(table) ?? new Set<string>();
    for (const column of source.sql.columns) {
      columns.add(column);
    }
    byTable.set(table, columns);
    for (const through of [
      ...source.sql.throughs,
      ...(source.sql.userThrough === undefined ? [] : [source.sql.userThrough]),
    ]) {
      const keys = tableKey(through.table);
      byTable.set(
        keys,
        new Set([...(byTable.get(keys) ?? []), through.id, through.key]),
      );
    }
  }
  return byTable;
}

/**
 * Every `schema.table.column` a claim or a membership is computed from: the
 * membership columns and the `attrs` table columns. Sorted.
 */
export function decidingColumns(
  config: PermDockConfig,
  attrs?: { readonly table?: string; readonly columns: readonly string[] },
  teams?: SupabaseHookConfig["teams"],
): readonly string[] {
  const entries = new Set<string>();
  for (const [table, columns] of membershipColumns(config)) {
    for (const column of columns) {
      entries.add(`${table}.${column}`);
    }
  }
  if (attrs?.table !== undefined) {
    const table = tableKey(attrs.table);
    for (const column of attrs.columns) {
      entries.add(`${table}.${column}`);
    }
  }
  if (teams !== undefined) {
    const table = tableKey(teams.table);
    for (const column of [teams.user, teams.team, teams.tenant]) {
      if (column !== undefined) {
        entries.add(`${table}.${column}`);
      }
    }
  }
  return [...entries].toSorted();
}
