import type { SupabaseManifestRole } from "./manifest.ts";
import type { RoleThrough } from "./types.ts";

import { quoteSqlIdent, quoteSqlTable } from "../core/sql.ts";

/** A roles table a role column references, by `schema.table`. */
export type RoleKeys = {
  readonly table: string;
  /** The roles table column the reference points at. */
  readonly id: string;
  /** The roles table column holding the role key. */
  readonly key: string;
  /** The referencing table's column. */
  readonly ref: string;
};

/** A role column as SQL over the row alias `alias`, joined to its roles table aliased `<alias>k`. */
export type RoleColumn = {
  /** The referencing table's column: the key itself, or the reference. */
  readonly column: string;
  /** The role key as text. */
  readonly sql: string;
  /** `join <roles> <alias>k on ...` after a newline and `indent` (a space without one), or `''`. */
  readonly join: string;
  /**
   * The role key as a scalar subquery, needing no `join`: for SQL that
   * names columns of an outer row unqualified, which a joined roles table
   * could capture.
   */
  readonly lookup: string;
  readonly through?: RoleKeys;
};

/**
 * Resolves a role column of `table` (`schema.table`, or `public`). An
 * unqualified `through` table is in `table`'s schema. `label` names the
 * option in the error for an `on` that is not exactly one column; `prefix`
 * starts every error.
 */
export function roleColumn(
  role: string | RoleThrough,
  table: string,
  alias: string,
  options: {
    readonly label: string;
    readonly prefix?: string;
    readonly indent?: string;
  },
): RoleColumn {
  const prefix = options.prefix ?? "PermDock";
  const q = (name: string): string => quoteSqlIdent(name, prefix);
  if (typeof role === "string") {
    return {
      column: role,
      sql: `${alias}.${q(role)}::text`,
      join: "",
      lookup: `${alias}.${q(role)}::text`,
    };
  }
  const pairs = Object.entries(role.on);
  const [pair] = pairs;
  if (pair === undefined || pairs.length !== 1) {
    throw new TypeError(
      `${prefix}: ${options.label}.on must map exactly one column of ${table} to ${role.through}, for example { role_id: 'id' }`,
    );
  }
  const [ref, id] = pair;
  const schema = table.includes(".")
    ? (table.split(".")[0] ?? "public")
    : "public";
  const through = role.through.includes(".")
    ? role.through
    : `${schema}.${role.through}`;
  const keys = `${alias}k`;
  const target = quoteSqlTable(through, prefix);
  return {
    column: ref,
    sql: `${keys}.${q(role.column)}::text`,
    join: `${options.indent === undefined ? " " : `\n${options.indent}`}join ${target} ${keys} on ${keys}.${q(id)} = ${alias}.${q(ref)}`,
    lookup: `(select ${keys}.${q(role.column)}::text from ${target} ${keys} where ${keys}.${q(id)} = ${alias}.${q(ref)})`,
    through: { table: through, id, key: role.column, ref },
  };
}

/** The manifest entry of a role column: the column, and the roles table it references. */
export function roleManifest(role: RoleColumn): SupabaseManifestRole {
  return role.through === undefined
    ? { column: role.column }
    : {
        column: role.column,
        through: {
          table: role.through.table,
          id: role.through.id,
          column: role.through.key,
        },
      };
}
