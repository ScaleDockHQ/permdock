import type { SupabaseManifestRole } from "../supabase/manifest.ts";
import type { GlobalRoles } from "./types.ts";

import { type RoleKeys, roleColumn, roleManifest } from "../supabase/roles.ts";
import { quoteIdent, quoteTable } from "./rls-sql.ts";

/** A global-roles source as SQL: the `from` clause and the user and role key expressions. */
export type RoleRows = {
  readonly table: string;
  readonly user: string;
  readonly from: string;
  readonly userSql: string;
  readonly roleSql: string;
  /** Set when the key is read through a roles table. */
  readonly through?: RoleKeys;
  /** The role column in the manifest's shape. */
  readonly role: SupabaseManifestRole | readonly SupabaseManifestRole[];
};

function qualify(name: string, schema: string): string {
  return name.includes(".") ? name : `${schema}.${name}`;
}

/** Resolves `source` against `schema`, aliasing the table `alias` and the roles table `<alias>k`. */
export function globalRoleSource(
  source: GlobalRoles,
  schema: string,
  alias: string,
): RoleRows {
  const table = qualify(source.table, schema);
  const user = source.user ?? "user_id";
  const role = roleColumn(source.role ?? "role", table, alias, {
    label: "roles.role",
    prefix: "PermDock CLI",
    indent: "    ",
  });
  return {
    table,
    user,
    from: `${quoteTable(table)} ${alias}${role.join}`,
    userSql: `${alias}.${quoteIdent(user)}`,
    roleSql: role.sql,
    role: roleManifest(role),
    ...(role.through === undefined ? {} : { through: role.through }),
  };
}
