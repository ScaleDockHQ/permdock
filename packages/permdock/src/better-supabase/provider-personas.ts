import type { AuthorizationFixtureRole } from "better-supabase/contract";

import type { CatalogDocument, CatalogRole } from "../catalog/types.ts";
import type {
  SupabaseManifest,
  SupabaseManifestMembership,
  SupabaseManifestRole,
} from "../supabase/manifest.ts";

import { quoteSqlLiteral, sqlIdent } from "../core/sql.ts";

/** A column and the SQL that fills it in a persona's setup. */
type Value = { readonly column: string; readonly sql: string };

/** The rows a persona's setup inserts, or why it can't write them. */
type Setup = { readonly sql: string } | { readonly problem: string };

function personaName(key: string): string {
  const name = key.toLowerCase().replaceAll(/[^a-z0-9_]/gu, "_");
  if (name === "" || name.startsWith("_") || !/^[a-z]/u.test(name)) {
    return `role_${name}`;
  }
  return name;
}

function insertSql(table: string, values: readonly Value[]): string {
  return `insert into ${table} (${values.map((value) => sqlIdent(value.column)).join(", ")}) values (${values.map((value) => value.sql).join(", ")})`;
}

function isRoleList(
  role: SupabaseManifestMembership["role"],
): role is readonly SupabaseManifestRole[] {
  return Array.isArray(role);
}

/**
 * How `role` puts `key` on a row: the column value (a literal, the id of the
 * roles row that holds the key, or the stored value a map turns into it), the
 * second insert into a role set keyed by several columns, or nothing for fixed
 * roles that already include it. `undefined` when the source cannot hold
 * `key`.
 */
function roleValue(
  role: SupabaseManifestRole,
  key: string,
  customRoleTenant: string | undefined,
):
  | { readonly kind: "column"; readonly value: Value }
  | {
      readonly kind: "set";
      readonly table: string;
      readonly on: Readonly<Record<string, string>>;
      readonly column: string;
    }
  | { readonly kind: "fixed" }
  | undefined {
  const literal = quoteSqlLiteral(key);
  if ("value" in role) {
    const fixed = typeof role.value === "string" ? [role.value] : role.value;
    return fixed.includes(key) ? { kind: "fixed" } : undefined;
  }
  if ("map" in role) {
    const stored = Object.entries(role.map).find(
      ([, mapped]) => mapped === key,
    );
    return stored === undefined
      ? undefined
      : {
          kind: "column",
          value: { column: role.column, sql: quoteSqlLiteral(stored[0]) },
        };
  }
  if (!("through" in role)) {
    return { kind: "column", value: { column: role.column, sql: literal } };
  }
  const { through } = role;
  if (through.on !== undefined) {
    return {
      kind: "set",
      table: through.table,
      on: through.on,
      column: through.column,
    };
  }
  const declared =
    customRoleTenant === undefined
      ? ""
      : ` and r.${sqlIdent(customRoleTenant)} is null`;
  return {
    kind: "column",
    value: {
      column: role.column,
      sql: `(select r.${sqlIdent(through.id)} from ${through.table} r where r.${sqlIdent(through.column)} = ${literal}${declared})`,
    },
  };
}

function firstRole(
  role: SupabaseManifestMembership["role"],
  key: string,
  customRoleTenant: string | undefined,
): ReturnType<typeof roleValue> {
  const roles = isRoleList(role) ? role : [role];
  for (const entry of roles) {
    const value = roleValue(entry, key, customRoleTenant);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A member of `{tenant}` holding `role` through the tenant-scope source. */
function memberSetup(
  source: SupabaseManifestMembership,
  role: CatalogRole,
  tenantScope: string,
  customRoleTenant: string | undefined,
): Setup {
  const label = `fixtureRoles: ${role.key} through ${source.table}`;
  if ("through" in source.user) {
    return { problem: `${label}: the user id is read through another table.` };
  }
  if (source.within !== undefined) {
    return { problem: `${label}: the rows need the tenant's parent ids.` };
  }
  const held = firstRole(source.role, role.key, customRoleTenant);
  if (held === undefined) {
    return { problem: `${label}: no role column can hold the role.` };
  }
  const values: Value[] = [
    { column: source.user.column, sql: "{user}" },
    { column: source.id.column, sql: "{tenant}" },
  ];
  if ("column" in source.scope) {
    values.push({
      column: source.scope.column,
      sql: quoteSqlLiteral(tenantScope),
    });
  }
  const kind = role.for?.[0];
  if (
    source.via !== undefined &&
    "column" in source.via &&
    kind !== undefined
  ) {
    values.push({ column: source.via.column, sql: quoteSqlLiteral(kind) });
  }
  if (held.kind === "column") {
    values.push(held.value);
  }
  const clash = values.find((value, index) =>
    values.some(
      (other, at) =>
        at < index && other.column === value.column && other.sql !== value.sql,
    ),
  );
  if (clash !== undefined) {
    return { problem: `${label}: ${clash.column} would hold two values.` };
  }
  const member = insertSql(
    source.table,
    values.filter(
      (value, index) =>
        values.findIndex((other) => other.column === value.column) === index,
    ),
  );
  if (held.kind !== "set") {
    return { sql: member };
  }
  const filled = values.map((value) => [value.column, value.sql] as const);
  const set: Value[] = [];
  for (const [referencing, column] of Object.entries(held.on)) {
    const sql = filled.find(([name]) => name === referencing)?.[1];
    if (sql === undefined) {
      return { problem: `${label}: ${held.table} matches on ${referencing}.` };
    }
    set.push({ column, sql });
  }
  set.push({ column: held.column, sql: quoteSqlLiteral(role.key) });
  return { sql: `${member}; ${insertSql(held.table, set)}` };
}

/** A user holding the global `role` in `rls.roles`. */
function globalSetup(manifest: SupabaseManifest, role: CatalogRole): Setup {
  const roles = manifest.rls.roles;
  const label = `fixtureRoles: global role ${role.key}`;
  if (roles === undefined) {
    return { problem: `${label}: the manifest has no rls.roles table.` };
  }
  const held = firstRole(roles.role, role.key, undefined);
  if (held === undefined || held.kind === "set") {
    return { problem: `${label}: ${roles.table} cannot hold the role.` };
  }
  return {
    sql: insertSql(roles.table, [
      { column: roles.user.column, sql: "{user}" },
      ...(held.kind === "column" ? [held.value] : []),
    ]),
  };
}

/**
 * The keys a holder of `role` reaches at the tenant scope, as `idsWith` answers
 * them: its allows there without a row condition, minus its denies there
 * without one. A global role holds none.
 */
function heldKeys(
  catalog: CatalogDocument,
  role: string,
  tenantScope: string,
): readonly string[] {
  const grants = (catalog.grants ?? []).filter(
    (grant) =>
      grant.role === role &&
      grant.scope === tenantScope &&
      grant.where === undefined &&
      grant.check === undefined,
  );
  const denied = new Set(
    grants
      .filter((grant) => grant.effect === "deny")
      .map((grant) => grant.permission),
  );
  return [
    ...new Set(
      grants
        .filter(
          (grant) => grant.effect === "allow" && !denied.has(grant.permission),
        )
        .map((grant) => grant.permission),
    ),
  ].toSorted();
}

/**
 * better-supabase's `fixtureRoles` for `personas: 'roles'`: one entry per role
 * the manifest's `fixtureRoles` names, or without that field per catalog role
 * at the tenant scope and global role. A tenant role's `setup` inserts a member
 * of `{tenant}` into the first `rls.memberships` table of the tenant scope,
 * with the role's id when the table reads it through a roles table; a global
 * role goes into `rls.roles`. A role it can write no setup for is left out and
 * named in `problems`.
 */
export function fixtureRolesOf(
  manifest: SupabaseManifest,
  catalog: CatalogDocument,
  tenantScope: string,
  problems: string[],
): readonly AuthorizationFixtureRole[] {
  const source = manifest.rls.memberships.find(
    (entry) => !("value" in entry.scope) || entry.scope.value === tenantScope,
  );
  const catalogRoles = catalog.roles ?? [];
  const keys =
    manifest.fixtureRoles ??
    catalogRoles
      .filter((role) => role.on === tenantScope || role.on === undefined)
      .map((role) => role.key);
  const roles: AuthorizationFixtureRole[] = [];
  for (const key of keys) {
    const role = catalogRoles.find((entry) => entry.key === key);
    if (role === undefined) {
      problems.push(`fixtureRoles: the catalog has no role ${key}.`);
      continue;
    }
    if (role.on !== undefined && role.on !== tenantScope) {
      problems.push(
        `fixtureRoles: ${key} is a ${role.on} role, not one of the tenant scope ${tenantScope}.`,
      );
      continue;
    }
    const setup =
      role.on === undefined
        ? globalSetup(manifest, role)
        : source === undefined
          ? {
              problem: `fixtureRoles: no rls.memberships table holds ${tenantScope} members.`,
            }
          : memberSetup(
              source,
              role,
              tenantScope,
              manifest.rls.customRoleTenant,
            );
    if ("problem" in setup) {
      problems.push(setup.problem);
      continue;
    }
    roles.push({
      name: personaName(key),
      setup: setup.sql,
      permissions: heldKeys(catalog, key, tenantScope),
    });
  }
  return roles;
}
