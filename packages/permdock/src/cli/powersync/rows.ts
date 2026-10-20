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
import { bare } from "./names.ts";
import { isFixed, roleSources, scopeSourcesOf } from "./sources.ts";

type Device = (table: string) => string;

function throughColumn(through: RoleThrough, device: Device): LocalRowColumn {
  const [pair] = Object.entries(through.on);
  return {
    column: pair?.[0] ?? "",
    through: {
      table: device(through.through),
      id: pair?.[1] ?? "",
      column: through.column,
    },
  };
}

function roleColumn(source: RoleSource, device: Device): LocalRowColumn {
  if (typeof source === "string") {
    return { column: source };
  }
  return "map" in source
    ? { column: source.column, map: source.map }
    : throughColumn(source, device);
}

function roleColumns(
  roles: RoleSpec,
  device: Device,
): readonly LocalRowColumn[] {
  return roleSources(roles).map((source) => roleColumn(source, device));
}

function sourceRows(
  stream: MembershipStream,
  device: Device,
): LocalMembershipRows {
  return compact<LocalMembershipRows>({
    table: device(stream.table),
    user:
      typeof stream.user === "string"
        ? { column: stream.user }
        : throughColumn(stream.user, device),
    scope: stream.scope,
    id: stream.id,
    roles: isFixed(stream.roles)
      ? { value: [...stream.roles.value] }
      : roleColumns(stream.roles, device),
    via: stream.via,
    expiresAt: stream.expiresAt,
    disabledAt: stream.disabledAt,
  });
}

function tableRows(
  table: RlsMembershipTable,
  scope: string,
  id: string,
  device: Device,
): LocalMembershipRows {
  return compact<LocalMembershipRows>({
    table: device(table.table),
    user: { column: table.user },
    scope: { value: scope },
    id,
    roles: roleColumns(table.role, device),
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

/**
 * The manifest's `rows`: the tables the subject streams sync, as a device
 * reads them. A scope's `rls.memberships` table, else its membership
 * sources; the global roles table; and the custom-role tables in `database`
 * mode. `devices` holds the plan's renamed tables.
 */
export function localRows(
  policy: Policy,
  config: PermDockConfig,
  devices: ReadonlyMap<string, string>,
): LocalSnapshotRows {
  const names = { names: { renamed: devices, seen: new Set<string>() } };
  const device: Device = (table) => bare(table, names);
  const rls = config.rls;
  const scopes = scopeList(policy.scopes);
  const sources = membershipSourcesOf(config);
  const memberships: LocalMembershipRows[] = [];
  const seen = new Set<MembershipStream>();
  for (const scope of scopes) {
    const table = scopeMembershipTable(rls?.memberships, scopes, scope.name);
    if (table !== undefined) {
      const id = scopeColumn(table, scopes, scope.name);
      if (id !== undefined) {
        memberships.push(tableRows(table, scope.name, id, device));
      }
      continue;
    }
    for (const source of scopeSourcesOf(sources, scope.name)) {
      const { stream } = source.sql;
      if (stream !== undefined && !seen.has(stream)) {
        seen.add(stream);
        memberships.push(sourceRows(stream, device));
      }
    }
  }
  const schema = rls?.schema ?? PERMDOCK_SCHEMA;
  const database = rls?.authorize === "database";
  const global =
    rls?.roles ?? (database ? { table: `${schema}.user_roles` } : undefined);
  return compact<LocalSnapshotRows>({
    memberships,
    roles:
      global === undefined
        ? undefined
        : {
            table: device(global.table),
            user: global.user ?? "user_id",
            roles: [roleColumn(global.role ?? "role", device)],
          },
    customRoles:
      database && customRolesOn(rls)
        ? {
            permissions: device(`${schema}.${CUSTOM_ROLES.permissions}`),
            includes: device(`${schema}.${CUSTOM_ROLES.includes}`),
          }
        : undefined,
  });
}
