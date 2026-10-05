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
  /** Every column of the referencing table that holds a role or a reference. */
  readonly columns: readonly string[];
  /** Every roles table a column references. */
  readonly throughs: readonly RoleKeys[];
  /**
   * Several role sources: `join` expands each row into one row per non-null
   * role, so `lookup` is the same as `sql` and needs the `join`.
   */
  readonly lateral: boolean;
};

/** One role source of a membership row: a key column, or a reference to a roles table. */
export type RoleSource = string | RoleThrough;

/** A role source, or several the row holds at once. */
export type RoleSpec = RoleSource | readonly RoleSource[];

type RoleOptions = {
  readonly label: string;
  readonly prefix?: string;
  readonly indent?: string;
};

function isRoleList(role: RoleSpec): role is readonly RoleSource[] {
  return Array.isArray(role);
}

/**
 * Resolves the role sources of `table` (`schema.table`, or `public`). An
 * unqualified `through` table is in `table`'s schema. `label` names the
 * option in the error for an `on` that is not exactly one column; `prefix`
 * starts every error. A row with several sources holds the union of their
 * non-null keys.
 */
export function roleColumn(
  role: RoleSpec,
  table: string,
  alias: string,
  options: RoleOptions,
): RoleColumn {
  if (!isRoleList(role)) {
    return singleRole(role, table, alias, options);
  }
  const prefix = options.prefix ?? "PermDock";
  const parts = role.map((part, index) =>
    singleRole(part, table, alias, {
      ...options,
      label: `${options.label}[${String(index)}]`,
    }),
  );
  const [first] = parts;
  if (first === undefined) {
    throw new TypeError(
      `${prefix}: ${options.label} needs at least one role source`,
    );
  }
  if (parts.length === 1) {
    return first;
  }
  const rows = quoteSqlIdent(`${alias}r`, prefix);
  const values = quoteSqlIdent(`${alias}v`, prefix);
  const sql = `${rows}.permdock_role`;
  return {
    column: first.column,
    sql,
    join: `${options.indent === undefined ? " " : `\n${options.indent}`}cross join lateral (select ${values}.role from (values ${parts.map((part) => `(${part.lookup})`).join(", ")}) ${values}(role) where ${values}.role is not null) ${rows}(permdock_role)`,
    lookup: sql,
    columns: [...new Set(parts.map((part) => part.column))],
    throughs: parts.flatMap((part) => part.throughs),
    lateral: true,
  };
}

function singleRole(
  role: RoleSource,
  table: string,
  alias: string,
  options: RoleOptions,
): RoleColumn {
  const prefix = options.prefix ?? "PermDock";
  const q = (name: string): string => quoteSqlIdent(name, prefix);
  if (typeof role === "string") {
    return {
      column: role,
      sql: `${alias}.${q(role)}::text`,
      join: "",
      lookup: `${alias}.${q(role)}::text`,
      columns: [role],
      throughs: [],
      lateral: false,
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
  const keyed = { table: through, id, key: role.column, ref };
  return {
    column: ref,
    sql: `${keys}.${q(role.column)}::text`,
    join: `${options.indent === undefined ? " " : `\n${options.indent}`}join ${target} ${keys} on ${keys}.${q(id)} = ${alias}.${q(ref)}`,
    lookup: `(select ${keys}.${q(role.column)}::text from ${target} ${keys} where ${keys}.${q(id)} = ${alias}.${q(ref)})`,
    through: keyed,
    columns: [ref],
    throughs: [keyed],
    lateral: false,
  };
}

/** The manifest entry of one role source: the column, and the roles table it references. */
function sourceManifest(
  column: string,
  through: RoleKeys | undefined,
): SupabaseManifestRole {
  return through === undefined
    ? { column }
    : {
        column,
        through: { table: through.table, id: through.id, column: through.key },
      };
}

/** The manifest entry of a role column, or one entry per source of a row with several. */
export function roleManifest(
  role: RoleColumn,
): SupabaseManifestRole | readonly SupabaseManifestRole[] {
  if (!role.lateral) {
    return sourceManifest(role.column, role.through);
  }
  return role.columns.map((column) =>
    sourceManifest(
      column,
      role.throughs.find((through) => through.ref === column),
    ),
  );
}
