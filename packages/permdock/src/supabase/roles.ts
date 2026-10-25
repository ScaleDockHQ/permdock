import type { SupabaseManifestRole } from "./manifest.ts";
import type { RoleMap, RoleThrough } from "./types.ts";

import {
  qualifySqlTable,
  quoteSqlIdent,
  quoteSqlLiteral,
  quoteSqlTable,
  sqlTextArray,
} from "../core/sql.ts";

/** A roles table a role column references, by `schema.table`. */
export type RoleKeys = {
  readonly table: string;
  /** The roles table column the reference points at. */
  readonly id: string;
  /** The roles table column holding the role key. */
  readonly key: string;
  /** The referencing table's column. */
  readonly ref: string;
  /**
   * Every referencing column and the column of `table` it matches, `ref` and
   * `id` first; more than one pair for a composite reference.
   */
  readonly match: readonly (readonly [ref: string, id: string])[];
};

/**
 * A role column as SQL over the row alias `alias`, joined to its roles table
 * aliased `<alias>k` (or `joined`).
 */
export type RoleColumn = {
  /** The referencing table's column: the key itself, or the reference. */
  readonly column: string;
  /** The role key as text. */
  readonly sql: string;
  /**
   * `join <roles> <alias>k on ...` after a newline and `indent` (a space
   * without one), or `''`.
   */
  readonly join: string;
  /**
   * The role key as a scalar subquery, needing no `join`: for SQL that names
   * columns of an outer row unqualified, which a joined roles table could
   * capture.
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
  /** The `map` of a mapped column: `sql` is then null for an unlisted value. */
  readonly map?: Readonly<Record<string, string | null>>;
  /**
   * Whether `sql` can be null for a row, so an aggregate has to leave those
   * out.
   */
  readonly nullable: boolean;
};

/**
 * One role source of a membership row: a key column, or a reference to a roles
 * table.
 */
export type RoleSource = string | RoleThrough | RoleMap;

/** A role source, or several the row holds at once. */
export type RoleSpec = RoleSource | readonly RoleSource[];

/**
 * A roles table whose tenant rows are written by tenants. A role key read
 * through it from a tenant row that is one of `declared` reads as null, so a
 * tenant cannot claim the grants of a declared role by naming a role after it.
 */
export type RoleGuard = {
  /** `schema.table`, or `public`. */
  readonly table: string;
  /** The tenant column of the roles table. */
  readonly tenant: string;
  /**
   * A tenant row with this column true is the application's own copy of a
   * declared role.
   */
  readonly skip?: string | undefined;
  readonly declared: readonly string[];
};

type RoleOptions = {
  readonly guard?: RoleGuard;
  readonly label: string;
  readonly prefix?: string;
  readonly indent?: string;
  readonly joined?: string;
  readonly example?: string;
  /**
   * Accepts an `on` of several columns, such as a role set keyed by
   * `(organization_id, user_id)`. Only membership sources set it: other readers
   * of a roles table match one column.
   */
  readonly composite?: boolean;
};

function isRoleList(role: RoleSpec): role is readonly RoleSource[] {
  return Array.isArray(role);
}

/**
 * Resolves the role sources of `table` (`schema.table`, or `public`). An
 * unqualified `through` table is in `table`'s schema. `label` names the option
 * in the error for an `on` that is not exactly one column; `prefix` starts
 * every error. A row with several sources holds the union of their non-null
 * keys.
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
    nullable: false,
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
      nullable: false,
    };
  }
  if ("map" in role) {
    const arms = Object.entries(role.map).map(
      ([value, key]) =>
        `when ${quoteSqlLiteral(value)} then ${key === null ? "null" : quoteSqlLiteral(key)}`,
    );
    const mapped = `case ${alias}.${q(role.column)}::text ${arms.join(" ")} else null end`;
    return {
      column: role.column,
      sql: mapped,
      join: "",
      lookup: mapped,
      columns: [role.column],
      throughs: [],
      lateral: false,
      map: role.map,
      nullable: true,
    };
  }
  const pairs = Object.entries(role.on);
  const [pair] = pairs;
  if (
    pair === undefined ||
    (pairs.length !== 1 && options.composite !== true)
  ) {
    throw new TypeError(
      options.composite === true
        ? `${prefix}: ${options.label}.on must map at least one column of ${table} to ${role.through}, for example ${options.example ?? "{ role_id: 'id' }"}`
        : `${prefix}: ${options.label}.on must map exactly one column of ${table} to ${role.through}, for example ${options.example ?? "{ role_id: 'id' }"}`,
    );
  }
  const [ref, id] = pair;
  const schema = table.includes(".")
    ? (table.split(".")[0] ?? "public")
    : "public";
  const through = role.through.includes(".")
    ? role.through
    : `${schema}.${role.through}`;
  const keys = options.joined ?? `${alias}k`;
  const target = quoteSqlTable(through, prefix);
  const keyed: RoleKeys = {
    table: through,
    id,
    key: role.column,
    ref,
    match: pairs,
  };
  const on = pairs
    .map(([from, to]) => `${keys}.${q(to)} = ${alias}.${q(from)}`)
    .join(" and ");
  const plain = `${keys}.${q(role.column)}::text`;
  const guard = options.guard;
  const key =
    guard !== undefined && qualifySqlTable(guard.table) === through
      ? `case when ${keys}.${q(guard.tenant)} is not null${guard.skip === undefined ? "" : ` and not coalesce(${keys}.${q(guard.skip)}, false)`} and ${plain} = any(${sqlTextArray(guard.declared)}) then null else ${plain} end`
      : plain;
  return {
    column: ref,
    sql: key,
    join: `${options.indent === undefined ? " " : `\n${options.indent}`}join ${target} ${keys} on ${on}`,
    lookup: `(select ${key} from ${target} ${keys} where ${on})`,
    through: keyed,
    columns: pairs.map(([from]) => from),
    throughs: [keyed],
    lateral: false,
    nullable: false,
  };
}

/**
 * The manifest entry of one role source: the column, and the roles table it
 * references.
 */
function sourceManifest(
  column: string,
  through: RoleKeys | undefined,
  map?: Readonly<Record<string, string | null>>,
): SupabaseManifestRole {
  if (map !== undefined) {
    return { column, map };
  }
  if (through === undefined) {
    return { column };
  }
  return {
    column,
    through: {
      table: through.table,
      id: through.id,
      column: through.key,
      ...(through.match.length > 1
        ? { on: Object.fromEntries(through.match) }
        : {}),
    },
  };
}

/** The manifest entry of a single-source column, such as a membership's user. */
export function columnManifest(role: RoleColumn): SupabaseManifestRole {
  return sourceManifest(role.column, role.through);
}

/**
 * The manifest entry of a role column, or one entry per source of a row with
 * several.
 */
export function roleManifest(
  role: RoleColumn,
): SupabaseManifestRole | readonly SupabaseManifestRole[] {
  if (!role.lateral) {
    return sourceManifest(role.column, role.through, role.map);
  }
  return role.columns.map((column) =>
    sourceManifest(
      column,
      role.throughs.find((through) => through.ref === column),
    ),
  );
}
