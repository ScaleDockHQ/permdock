import type { SupabaseManifestRole } from "../supabase/manifest.ts";
import type { GlobalRoles, RlsCustomRoleTable } from "./types.ts";

import { type RoleKeys, roleColumn, roleManifest } from "../supabase/roles.ts";
import { quoteIdent, quoteTable } from "./sql/quote.ts";

/** A global-roles source as SQL: the `from` clause and the user and role key expressions. */
export type RoleRows = {
  readonly table: string;
  readonly user: string;
  readonly from: string;
  readonly userSql: string;
  readonly roleSql: string;
  /** Set when the key is read through a roles table. */
  readonly through?: RoleKeys;
  readonly tenant?: string;
  /** The role column in the manifest's shape. */
  readonly role: SupabaseManifestRole | readonly SupabaseManifestRole[];
};

function qualify(name: string, schema: string): string {
  return name.includes(".") ? name : `${schema}.${name}`;
}

function throughTenant(
  through: RoleKeys | undefined,
  roles: RlsCustomRoleTable | undefined,
): string | undefined {
  if (through === undefined || roles?.tenant === undefined) {
    return undefined;
  }
  return qualify(roles.table, "public") === through.table
    ? roles.tenant
    : undefined;
}

/** Resolves `source` against `schema`, aliasing the table `alias` and the roles table `<alias>k`. */
export function globalRoleSource(
  source: GlobalRoles,
  schema: string,
  alias: string,
  roles?: RlsCustomRoleTable,
): RoleRows {
  const table = qualify(source.table, schema);
  const user = source.user ?? "user_id";
  const role = roleColumn(source.role ?? "role", table, alias, {
    label: "roles.role",
    prefix: "PermDock CLI",
    indent: "    ",
  });
  const tenant = role.lateral ? undefined : throughTenant(role.through, roles);
  const global =
    tenant === undefined ? "" : ` and ${alias}k.${quoteIdent(tenant)} is null`;
  return {
    table,
    user,
    from: `${quoteTable(table)} ${alias}${role.join}${global}`,
    userSql: `${alias}.${quoteIdent(user)}`,
    roleSql: role.sql,
    role: roleManifest(role),
    ...(role.through === undefined ? {} : { through: role.through }),
    ...(tenant === undefined ? {} : { tenant }),
  };
}
