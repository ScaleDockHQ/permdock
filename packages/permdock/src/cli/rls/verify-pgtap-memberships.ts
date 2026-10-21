import type { Membership } from "../../core/subject.ts";
import type { SupabaseManifestMembership } from "../../supabase/manifest.ts";
import type { RlsFixture } from "../fixtures.ts";
import type { PermDockConfig } from "../types.ts";

import { scopeColumn, scopeMembershipTable } from "../../conditions/compile.ts";
import {
  type Scope,
  normalizeMemberships,
  rootScope,
} from "../../core/scopes.ts";
import { quoteIdent, quoteLiteral, quoteTable } from "../sql/quote.ts";

type Column = readonly [column: string, value: string];

function insert(table: string, columns: readonly Column[]): string {
  return `insert into ${quoteTable(table)} (${columns.map(([name]) => quoteIdent(name)).join(", ")}) values (${columns.map(([, value]) => quoteLiteral(value)).join(", ")}) on conflict do nothing;`;
}

/**
 * The rows of a table mapped by `rls.memberships`: one per role, for a plain
 * role column.
 */
function mappedRows(
  config: PermDockConfig,
  scopes: readonly Scope[],
  user: string,
  membership: Membership,
): readonly string[] {
  const { scope, id } = membership;
  if (scope === undefined || id === undefined) {
    return [];
  }
  const table = scopeMembershipTable(config.rls?.memberships, scopes, scope);
  const idColumn =
    table === undefined ? undefined : scopeColumn(table, scopes, scope);
  const roleColumn = table?.role;
  if (
    table === undefined ||
    idColumn === undefined ||
    typeof roleColumn !== "string"
  ) {
    return [];
  }
  const rootName = rootScope(scopes);
  const tenantColumn =
    rootName === undefined || rootName === scope
      ? undefined
      : scopeColumn(table, scopes, rootName);
  const tenant =
    rootName === undefined ? undefined : membership.within?.[rootName];
  const extra: Column[] = [];
  for (const [name, value] of Object.entries(membership.within ?? {})) {
    const column = scopeColumn(table, scopes, name);
    if (column !== undefined && name !== scope) {
      extra.push([column, value]);
    }
  }
  if (
    tenantColumn !== undefined &&
    tenant !== undefined &&
    !extra.some(([column]) => column === tenantColumn)
  ) {
    extra.push([tenantColumn, tenant]);
  }
  return membership.roles.map((role) =>
    insert(table.table, [
      [table.user, user],
      [idColumn, id],
      ...extra,
      [roleColumn, role],
    ]),
  );
}

/**
 * The rows of a `membershipSources` source: only a source whose columns are
 * plain, never a `through` or `map`.
 */
function sourceRows(
  source: SupabaseManifestMembership,
  scopes: readonly Scope[],
  user: string,
  membership: Membership,
): readonly string[] {
  const { scope, id } = membership;
  if (scope === undefined || id === undefined) {
    return [];
  }
  const names = new Set(scopes.map((entry) => entry.name));
  if (
    "through" in source.user ||
    !names.has(scope) ||
    ("value" in source.scope && source.scope.value !== scope)
  ) {
    return [];
  }
  const role = source.role;
  const roleColumns =
    Array.isArray(role) || !("column" in role) || "through" in role
      ? undefined
      : "map" in role
        ? undefined
        : role.column;
  const fixed: Column[] =
    "value" in source.scope ? [] : [[source.scope.column, scope]];
  const within = source.within;
  const ancestors: Column[] =
    within === undefined || !("columns" in within)
      ? []
      : Object.entries(within.columns).flatMap(([name, column]) => {
          const value = membership.within?.[name];
          return value === undefined ? [] : [[column, value] as const];
        });
  const base: Column[] = [
    [source.user.column, user],
    [source.id.column, id],
    ...fixed,
    ...ancestors,
  ];
  if (roleColumns === undefined) {
    return [];
  }
  return membership.roles.map((value) =>
    insert(source.table, [...base, [roleColumns, value]]),
  );
}

/**
 * The statements that put a fixture's memberships into the configured
 * membership tables and sources, so the helpers of `authorize: 'database'` find
 * them. A membership no plain table or source can hold (a `through` or mapped
 * role column, an `on` membership) is listed in a comment.
 */
export function fixtureMembershipSql(
  config: PermDockConfig,
  scopes: readonly Scope[],
  fixture: RlsFixture,
  sources: readonly SupabaseManifestMembership[],
): readonly string[] {
  const lines: string[] = [];
  for (const membership of normalizeMemberships(
    fixture.subject.memberships ?? [],
    scopes,
  )) {
    const rows = [
      ...mappedRows(config, scopes, fixture.subject.id, membership),
      ...sources.flatMap((source) =>
        sourceRows(source, scopes, fixture.subject.id, membership),
      ),
    ];
    if (rows.length === 0) {
      lines.push(
        `-- no membership table holds ${membership.scope ?? "on"} ${membership.id ?? ""}: not seeded`,
      );
    }
    lines.push(...rows);
  }
  return lines;
}
