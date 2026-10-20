import type {
  LocalMembershipRows,
  LocalRowColumn,
  LocalSnapshotRows,
} from "../core/snapshot-types.ts";
import type {
  CustomRole,
  CustomRoleGrant,
  Membership,
} from "../core/subject.ts";
import type { LocalSnapshotData } from "./local.ts";

import { compact, isRecord } from "../core/compact.ts";

type Row = Readonly<Record<string, unknown>>;

/** The signed-in user the rows are read for. */
export type RowPrincipal = {
  readonly id: string;
  readonly tenant?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
};
type Tables = Readonly<Record<string, readonly unknown[]>>;

function isColumns(
  roles: LocalMembershipRows["roles"],
): roles is readonly LocalRowColumn[] {
  return Array.isArray(roles);
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The synced tables `rows` names, each read whole: the subject streams sync only the user's own rows. */
export function rowTables(rows: LocalSnapshotRows): readonly string[] {
  const tables = new Set<string>();
  const column = (item: LocalRowColumn): void => {
    if ("through" in item) {
      tables.add(item.through.table);
    }
  };
  for (const source of rows.memberships) {
    tables.add(source.table);
    column(source.user);
    if (isColumns(source.roles)) {
      for (const item of source.roles) {
        column(item);
      }
    }
  }
  if (rows.roles !== undefined) {
    tables.add(rows.roles.table);
    for (const item of rows.roles.roles) {
      column(item);
    }
  }
  if (rows.customRoles !== undefined) {
    tables.add(rows.customRoles.permissions);
    tables.add(rows.customRoles.includes);
  }
  return [...tables];
}

export function rowQuery(table: string): string {
  return `SELECT * FROM ${quoted(table)}`;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value === "" ? undefined : value;
  }
  return typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : undefined;
}

function isSet(row: Row, column: string | undefined): boolean {
  const value = column === undefined ? undefined : row[column];
  return value !== undefined && value !== null;
}

function rowsOf(tables: Tables, table: string): readonly Row[] {
  return (tables[table] ?? []).filter(isRecord);
}

/** The value a column holds, read through its referenced table or map; `undefined` for none. */
function columnValue(
  row: Row,
  column: LocalRowColumn,
  tables: Tables,
): string | undefined {
  const raw = text(row[column.column]);
  if (raw === undefined) {
    return undefined;
  }
  if ("through" in column) {
    const { through } = column;
    const target = rowsOf(tables, through.table).find(
      (item) => text(item[through.id]) === raw,
    );
    return target === undefined ? undefined : text(target[through.column]);
  }
  if ("map" in column) {
    return Object.hasOwn(column.map, raw)
      ? (column.map[raw] ?? undefined)
      : undefined;
  }
  return raw;
}

function membershipsOf(
  source: LocalMembershipRows,
  tables: Tables,
  user: string,
): readonly Membership[] {
  const byInstance = new Map<
    string,
    { scope: string; id: string; via: string | undefined; roles: Set<string> }
  >();
  for (const row of rowsOf(tables, source.table)) {
    if (
      columnValue(row, source.user, tables) !== user ||
      isSet(row, source.expiresAt) ||
      isSet(row, source.disabledAt)
    ) {
      continue;
    }
    const scope =
      "value" in source.scope
        ? source.scope.value
        : text(row[source.scope.column]);
    const id = text(row[source.id]);
    const via =
      source.via === undefined
        ? undefined
        : "value" in source.via
          ? source.via.value
          : text(row[source.via.column]);
    const roles = isColumns(source.roles)
      ? source.roles.flatMap((column) => {
          const key = columnValue(row, column, tables);
          return key === undefined ? [] : [key];
        })
      : source.roles.value;
    if (scope === undefined || id === undefined || roles.length === 0) {
      continue;
    }
    const key = JSON.stringify([scope, id, via ?? null]);
    const entry = byInstance.get(key) ?? { scope, id, via, roles: new Set() };
    for (const role of roles) {
      entry.roles.add(role);
    }
    byInstance.set(key, entry);
  }
  return [...byInstance.values()].map((entry) =>
    compact<Membership>({
      scope: entry.scope,
      id: entry.id,
      roles: [...entry.roles].toSorted(),
      via: entry.via,
    }),
  );
}

type RoleKey = {
  readonly tenant: string | undefined;
  readonly scope: string;
  readonly id: string | undefined;
  readonly name: string;
};

function roleKeyOf(row: Row): RoleKey | undefined {
  const name = text(row["role"]);
  const scope = text(row["scope"]);
  return name === undefined || scope === undefined
    ? undefined
    : {
        tenant: text(row["tenant_id"]),
        scope,
        id: text(row["scope_id"]),
        name,
      };
}

type RoleEntry = {
  readonly key: RoleKey;
  readonly grants: CustomRoleGrant[];
  readonly includes: string[];
};

function customRoleOf({ key, grants, includes }: RoleEntry): CustomRole {
  const body = { name: key.name, grants, includes };
  if (key.scope === "global") {
    return { ...body, scope: "global" };
  }
  if (key.tenant === undefined) {
    return { ...body, shared: true, scope: key.scope };
  }
  return compact<CustomRole>({
    ...body,
    tenant: key.tenant,
    scope: key.scope,
    id: key.id,
  });
}

/** Custom roles from the custom-role rows: a tenant role, a shared role (no tenant) or a global role. */
function customRolesOf(
  permissions: readonly Row[],
  includes: readonly Row[],
): readonly CustomRole[] {
  const roles = new Map<string, RoleEntry>();
  const entry = (key: RoleKey): RoleEntry => {
    const id = JSON.stringify([
      key.tenant ?? null,
      key.scope,
      key.id ?? null,
      key.name,
    ]);
    const found = roles.get(id) ?? { key, grants: [], includes: [] };
    roles.set(id, found);
    return found;
  };
  for (const row of permissions) {
    const key = roleKeyOf(row);
    const permission = text(row["permission"]);
    const effect = row["effect"] === "deny" ? "deny" : "allow";
    const level = text(row["level"]);
    if (key !== undefined && permission !== undefined) {
      entry(key).grants.push(
        compact<CustomRoleGrant>({ permission, effect, level }),
      );
    }
  }
  for (const row of includes) {
    const key = roleKeyOf(row);
    const include = text(row["include_role"]);
    if (key !== undefined && include !== undefined) {
      entry(key).includes.push(include);
    }
  }
  return [...roles.values()].map(customRoleOf);
}

/** The user's memberships, global roles and custom roles from the rows of the tables `rows` names. */
export function readRows(
  rows: LocalSnapshotRows,
  tables: Tables,
  principal: RowPrincipal,
): LocalSnapshotData {
  const { id: user, tenant, attributes } = principal;
  const memberships = rows.memberships.flatMap((source) =>
    membershipsOf(source, tables, user),
  );
  const global = rows.roles;
  const roles =
    global === undefined
      ? []
      : rowsOf(tables, global.table).flatMap((row) =>
          text(row[global.user]) === user
            ? global.roles.flatMap((column) => {
                const key = columnValue(row, column, tables);
                return key === undefined ? [] : [key];
              })
            : [],
        );
  const custom = rows.customRoles;
  return {
    principal: {
      id: user,
      roles: [...new Set(roles)].toSorted(),
      memberships,
      ...(tenant === undefined ? {} : { tenant }),
      ...(attributes === undefined ? {} : { attributes }),
    },
    ...(custom === undefined
      ? {}
      : {
          customRoles: customRolesOf(
            rowsOf(tables, custom.permissions),
            rowsOf(tables, custom.includes),
          ),
        }),
  };
}
