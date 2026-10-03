import type { GlobalRoles } from "./types.ts";

import { quoteIdent, quoteTable } from "./rls-sql.ts";

/** A global-roles source as SQL: the `from` clause and the user and role key expressions. */
export type RoleRows = {
  readonly table: string;
  readonly user: string;
  readonly from: string;
  readonly userSql: string;
  readonly roleSql: string;
  /** Set when the key is read through a roles table. */
  readonly through?: {
    readonly table: string;
    readonly id: string;
    readonly key: string;
    readonly ref: string;
  };
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
  const userSql = `${alias}.${quoteIdent(user)}`;
  const role = source.role ?? "role";
  if (typeof role === "string") {
    return {
      table,
      user,
      from: `${quoteTable(table)} ${alias}`,
      userSql,
      roleSql: `${alias}.${quoteIdent(role)}::text`,
    };
  }
  const pairs = Object.entries(role.on);
  const [pair] = pairs;
  if (pair === undefined || pairs.length !== 1) {
    throw new Error(
      `PermDock CLI: roles.role.on must map exactly one column of ${table} to ${role.through}, for example { role_id: 'id' }`,
    );
  }
  const [ref, id] = pair;
  const through = qualify(role.through, table.split(".")[0] ?? schema);
  const keys = `${alias}k`;
  return {
    table,
    user,
    from: `${quoteTable(table)} ${alias}
    join ${quoteTable(through)} ${keys} on ${keys}.${quoteIdent(id)} = ${alias}.${quoteIdent(ref)}`,
    userSql,
    roleSql: `${keys}.${quoteIdent(role.column)}::text`,
    through: { table: through, id, key: role.column, ref },
  };
}
