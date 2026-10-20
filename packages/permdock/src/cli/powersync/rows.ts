import type {
  LocalMembershipRows,
  LocalRowColumn,
  LocalSnapshotRows,
} from "../../core/snapshot-types.ts";
import type { Policy } from "../../index.ts";
import type { RoleSource, RoleSpec } from "../../supabase/roles.ts";
import type { MembershipStream } from "../../supabase/sources.ts";
import type { RoleThrough } from "../../supabase/types.ts";
import type { PermDockConfig, RlsMembershipTable } from "../types.ts";

import { scopeColumn, scopeMembershipTable } from "../../conditions/compile.ts";
import { compact } from "../../core/compact.ts";
import { scopeList } from "../../core/scopes.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { CUSTOM_ROLES, customRolesOn } from "../sql/shared.ts";
import { membershipSourcesOf } from "../sql/sources.ts";
import { isFixed, roleSources, scopeSourcesOf } from "./sources.ts";

/** A synced table's name on the device: PowerSync drops the schema. */
function deviceTable(table: string): string {
  return table.split(".").at(-1) ?? table;
}

function throughColumn(through: RoleThrough): LocalRowColumn {
  const [pair] = Object.entries(through.on);
  return {
    column: pair?.[0] ?? "",
    through: {
      table: deviceTable(through.through),
      id: pair?.[1] ?? "",
      column: through.column,
    },
  };
}

function roleColumn(source: RoleSource): LocalRowColumn {
  if (typeof source === "string") {
    return { column: source };
  }
  return "map" in source
    ? { column: source.column, map: source.map }
    : throughColumn(source);
}

function roleColumns(roles: RoleSpec): readonly LocalRowColumn[] {
  return roleSources(roles).map(roleColumn);
}

function sourceRows(stream: MembershipStream): LocalMembershipRows {
  return compact<LocalMembershipRows>({
    table: deviceTable(stream.table),
    user:
      typeof stream.user === "string"
        ? { column: stream.user }
        : throughColumn(stream.user),
    scope: stream.scope,
    id: stream.id,
    roles: isFixed(stream.roles)
      ? { value: [...stream.roles.value] }
      : roleColumns(stream.roles),
    via: stream.via,
    expiresAt: stream.expiresAt,
    disabledAt: stream.disabledAt,
  });
}

function tableRows(
  table: RlsMembershipTable,
  scope: string,
  id: string,
): LocalMembershipRows {
  return compact<LocalMembershipRows>({
    table: deviceTable(table.table),
    user: { column: table.user },
    scope: { value: scope },
    id,
    roles: roleColumns(table.role),
    via:
      table.via === undefined
        ? undefined
        : typeof table.via === "string"
          ? { column: table.via }
          : table.via,
    expiresAt: table.expiresAt,
    disabledAt: table.disabledAt,
  });
}

/** One warning per device table name that more than one synced table maps to. */
function collisions(tables: readonly string[]): readonly string[] {
  const byName = new Map<string, Set<string>>();
  for (const table of tables) {
    const qualified = table.includes(".") ? table : `public.${table}`;
    const name = deviceTable(table);
    byName.set(name, (byName.get(name) ?? new Set()).add(qualified));
  }
  return [...byName].flatMap(([name, qualified]) =>
    qualified.size > 1
      ? [
          `${[...qualified].toSorted().join(" and ")} share the device table ${name}: rename one so the device reads each apart`,
        ]
      : [],
  );
}

/**
 * The manifest's `rows`: the tables the subject streams sync, as a device
 * reads them. A scope's `rls.memberships` table, else its membership
 * sources; the global roles table; and the custom-role tables in `database`
 * mode. `warnings` names synced tables whose device names collide.
 */
export function localRows(
  policy: Policy,
  config: PermDockConfig,
): { readonly rows: LocalSnapshotRows; readonly warnings: readonly string[] } {
  const rls = config.rls;
  const scopes = scopeList(policy.scopes);
  const sources = membershipSourcesOf(config);
  const memberships: LocalMembershipRows[] = [];
  const synced: string[] = [];
  const seen = new Set<MembershipStream>();
  for (const scope of scopes) {
    const table = scopeMembershipTable(rls?.memberships, scopes, scope.name);
    if (table !== undefined) {
      const id = scopeColumn(table, scopes, scope.name);
      if (id !== undefined) {
        memberships.push(tableRows(table, scope.name, id));
        synced.push(table.table);
      }
      continue;
    }
    for (const source of scopeSourcesOf(sources, scope.name)) {
      const { stream } = source.sql;
      if (stream !== undefined && !seen.has(stream)) {
        seen.add(stream);
        memberships.push(sourceRows(stream));
        synced.push(stream.table);
      }
    }
  }
  const schema = rls?.schema ?? PERMDOCK_SCHEMA;
  const database = rls?.authorize === "database";
  const global =
    rls?.roles ?? (database ? { table: `${schema}.user_roles` } : undefined);
  if (global !== undefined) {
    synced.push(global.table);
  }
  const rows = compact<LocalSnapshotRows>({
    memberships,
    roles:
      global === undefined
        ? undefined
        : {
            table: deviceTable(global.table),
            user: global.user ?? "user_id",
            roles: [roleColumn(global.role ?? "role")],
          },
    customRoles:
      database && customRolesOn(rls)
        ? {
            permissions: CUSTOM_ROLES.permissions,
            includes: CUSTOM_ROLES.includes,
          }
        : undefined,
  });
  return { rows, warnings: collisions(synced) };
}
