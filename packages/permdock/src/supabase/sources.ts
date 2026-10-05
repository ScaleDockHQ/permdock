import type { MemberEntry, MembershipSource } from "../core/interfaces.ts";
import type { Membership } from "../core/subject.ts";
import type { SupabaseManifestMembership } from "./manifest.ts";
import type {
  RoleThrough,
  SupabaseActiveRow,
  SupabaseSuspension,
} from "./types.ts";

import { compact } from "../core/compact.ts";
import { quoteSqlIdent, quoteSqlLiteral, quoteSqlTable } from "../core/sql.ts";
import {
  type RoleColumn,
  type RoleKeys,
  type RoleSpec,
  columnManifest,
  roleColumn,
  roleManifest,
} from "./roles.ts";

/**
 * Runs one parameterised statement: `pg`'s `client.query` (which resolves
 * `{ rows }`) and `postgres`'s `sql.unsafe` (which resolves the rows) both fit.
 */
export type SqlQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<
  | readonly Record<string, unknown>[]
  | { readonly rows: readonly Record<string, unknown>[] }
>;

type Common = {
  readonly table: string;
  /** Runs the lookups; without it the source only describes SQL (for `permdock supabase hook generate`). */
  readonly query?: SqlQuery;
  /** Drop suspended users and memberships under suspended instances, like `rls.suspension`. */
  readonly suspension?: SupabaseSuspension;
};

export type MembershipTableOptions = Common & {
  /** Column names; `user`, `scope`, `id` and `role` default to `user_id`, `scope`, `scope_id`, `role`. */
  readonly columns?: {
    /** The user id column, or a reference to a table that holds the user id. */
    readonly user?: string | RoleThrough;
    readonly scope?: string;
    readonly id?: string;
    /** A `jsonb` column of ancestor ids keyed by scope name. */
    readonly within?: string;
    /**
     * The role key column, a reference to a roles table that holds the key,
     * or several of them: the row holds every non-null key.
     */
    readonly role?: string | RoleThrough | readonly (string | RoleThrough)[];
    readonly via?: string;
    readonly expiresAt?: string;
    /** The principal id that wrote the membership (`grantedBy`). */
    readonly grantedBy?: string;
    /** Free-text justification recorded on the membership (`reason`). */
    readonly reason?: string;
    /** A subgroup column filling `member.group`. */
    readonly group?: string;
    /** A text column; the value `idp` marks the row as owned by the identity provider. */
    readonly managedBy?: string;
    /** A `text[]` column of seats. */
    readonly seats?: string;
  };
};

export type MembershipJunctionOptions = Common & {
  /** The declared scope every row is a membership of. */
  readonly scope: string;
  /** The user id column (default `user_id`), or a reference to a table that holds the user id. */
  readonly user?: string | RoleThrough;
  /** The column holding the scope instance id. Default `<scope>_id`. */
  readonly id?: string;
  /** Ancestor id columns keyed by scope name. */
  readonly within?: Readonly<Record<string, string>>;
  /**
   * A role column, a reference to a roles table that holds the key, fixed
   * roles every row holds (a contact table with no role column), or
   * `{ sources }`: several role columns whose non-null keys the row holds.
   */
  readonly roles:
    | string
    | RoleThrough
    | readonly string[]
    | { readonly sources: readonly (string | RoleThrough)[] };
  /** The membership kind every row has (`contact`, `staff`, `partner`). */
  readonly via?: string;
  readonly expiresAt?: string;
  /** The principal id that wrote the membership (`grantedBy`). */
  readonly grantedBy?: string;
  /** Free-text justification recorded on the membership (`reason`). */
  readonly reason?: string;
  /** A subgroup filling `member.group`: a fixed name every row has, or a column. */
  readonly group?: string | { readonly column: string };
  /** `idp` when the identity provider owns every row, or a text column holding `idp` per row. */
  readonly managedBy?: "idp" | { readonly column: string };
  /** A `text[]` column of seats. */
  readonly seats?: string;
};

/** What `permdock supabase hook generate` compiles; the same SQL the source runs. */
export type MembershipSql = {
  readonly table: string;
  /** The table's user column: the user id, or with `userThrough` the reference to the row holding it. */
  readonly user: string;
  /** The table that holds the user id when `user` references it; a change of that id bumps the old and the new user. */
  readonly userThrough?: RoleKeys;
  /** `<table>.<user>%type`: the PL/pgSQL type of the user id column, for a variable `select` compares with. */
  readonly userType: string;
  /**
   * The `select` of claim rows for one user, with every filter applied.
   * `user` must have the column's type (a `userType` variable, or an untyped
   * `$1` Postgres infers): the column is compared uncast so its index applies.
   */
  select(user: string): string;
  /** The `select` of member rows for one scope instance (`$1` scope, `$2` id). */
  list(): string;
  /** A text column holding `idp` for rows the identity provider owns; `''` when every row is owned. */
  readonly managed?: string;
  /** Other tables the `select` reads (suspension tables). */
  readonly reads: readonly string[];
  /** The roles table the role column references; a key change bumps every holder's authorization version. */
  readonly through?: RoleKeys;
  /** Every roles table the role columns reference, `through` first. */
  readonly throughs: readonly RoleKeys[];
  /** Every column that decides who holds which membership: user, scope, id, `within`, role, `via` and expiry. */
  readonly columns: readonly string[];
  /** For a single-scope source: its scope and the scopes whose ids each row carries. */
  readonly scope?: string;
  readonly holds?: readonly string[];
  /** The source's entry in the hook manifest's `memberships`. */
  readonly manifest: SupabaseManifestMembership;
  /** What the ownership triggers count; absent on a source that is not a table. */
  readonly holders?: MembershipHolders;
};

/**
 * The rows of a membership table, for the holder-count and transfer-only
 * triggers `permdock rls generate` puts on it. No suspension filter: a
 * suspended holder still holds the role.
 */
export type MembershipHolders = {
  /** `<table>.<id column>%type`: the type of a variable `rows` compares the id column with. */
  readonly idType: string;
  /** The instance id of scope `scope` the PL/pgSQL record `row` holds, as text; null on a row of another scope. */
  id(scope: string, row: string): string;
  /**
   * `select id, user_id, role, via, live` over the rows of scope `scope`
   * in `from` (default the table): one row per held role key, `live` false
   * once expired. `id` is an expression of `idType` the id column must equal.
   */
  rows(
    scope: string,
    options?: { readonly id?: string; readonly from?: string },
  ): string;
};

export type SqlMembershipSource = MembershipSource & {
  readonly sql: MembershipSql;
};

const ident = (name: string): string => quoteSqlIdent(name);
const literal = quoteSqlLiteral;

function qualifiedName(name: string): string {
  return name.includes(".") ? name : `public.${name}`;
}

function qualified(name: string): string {
  return quoteSqlTable(qualifiedName(name));
}

function col(name: string): string {
  return `m.${ident(name)}`;
}

function activeRow(row: SupabaseActiveRow, id: string): string {
  const parts = [`s.${ident(row.id)}::text = (${id})::text`];
  if (row.disabledAt !== undefined) {
    parts.push(`s.${ident(row.disabledAt)} is null`);
  }
  if (row.status !== undefined) {
    const values = row.active ?? [];
    if (values.length === 0) {
      throw new TypeError(
        "PermDock: a suspension status column needs its active values",
      );
    }
    parts.push(
      `s.${ident(row.status)}::text = any(array[${values.map(literal).join(", ")}]::text[])`,
    );
  }
  if (row.disabledAt === undefined && row.status === undefined) {
    throw new TypeError(
      "PermDock: a suspension table needs disabledAt or status",
    );
  }
  return `exists (select 1 from ${qualified(row.table)} s where ${parts.join(" and ")})`;
}

type Shape = {
  readonly table: string;
  /** Joins after `from <table> m`: the user table of a `through` user, the roles table of a `through` role column. */
  readonly join: string;
  readonly through: RoleKeys | undefined;
  readonly throughs: readonly RoleKeys[];
  readonly user: string;
  /** The user id, uncast: `m.<user>`, or `mu.<column>` of a `through` user. */
  readonly userSql: string;
  readonly userThrough: RoleKeys | undefined;
  readonly scope: string;
  readonly id: string;
  readonly within: string;
  readonly roles: string;
  readonly via: string;
  readonly expiresAt: string | undefined;
  readonly grantedBy: string;
  readonly reason: string;
  readonly memberGroup: string;
  readonly managed: string;
  readonly managedColumn: string | undefined;
  readonly seats: string;
  /** SQL for the id the row holds for scope `name`, or `null` when it holds none. */
  readonly idOf: (name: string) => string | undefined;
  /** The id column, and the filter keeping the rows of scope `name` over `alias` (`undefined` for none). */
  readonly idColumn: string;
  readonly holds: (name: string, alias: string) => string | undefined;
  /** The role key of one row, after `join` and `roleJoin`: one row per held key. */
  readonly roleKey: string;
  readonly roleJoin: string;
  readonly groupBy: readonly string[];
  readonly suspension: SupabaseSuspension | undefined;
  readonly columns: readonly string[];
  readonly manifest: Omit<SupabaseManifestMembership, "table" | "columns">;
};

function filters(shape: Shape, owner: string): string[] {
  const lines = [owner];
  if (shape.expiresAt !== undefined) {
    const expires = col(shape.expiresAt);
    lines.push(`(${expires} is null or ${expires} > now())`);
  }
  const users = shape.suspension?.users;
  if (users !== undefined) {
    lines.push(activeRow(users, shape.userSql));
  }
  for (const [name, row] of Object.entries(shape.suspension?.scopes ?? {})) {
    const id = shape.idOf(name);
    if (id !== undefined) {
      lines.push(`(${id} is null or ${activeRow(row, id)})`);
    }
  }
  return lines;
}

function selectOf(
  shape: Shape,
  where: readonly string[],
  user: boolean,
): string {
  const fields = [
    ...(user ? [`${shape.userSql}::text as user_id`] : []),
    `${shape.scope} as scope`,
    `${shape.id} as id`,
    `${shape.within} as within`,
    `${shape.roles} as roles`,
    `${shape.via} as via`,
    `${shape.expiresAt === undefined ? "null::bigint" : `floor(extract(epoch from ${col(shape.expiresAt)}))::bigint`} as expires_at`,
    `${shape.grantedBy} as granted_by`,
    `${shape.reason} as reason`,
    `${shape.memberGroup} as member_group`,
    `${shape.managed} as managed_by`,
    `${shape.seats} as seats`,
  ];
  const group = [...(user ? [shape.userSql] : []), ...shape.groupBy];
  return `select ${fields.join(", ")}
from ${qualified(shape.table)} m${shape.join}
where ${where.join("\n  and ")}
group by ${group.join(", ")}`;
}

function holdersOf(shape: Shape): MembershipHolders {
  const id = ident(shape.idColumn);
  return {
    idType: `${qualified(shape.table)}.${id}%type`,
    id: (scope, row) => {
      const filter = shape.holds(scope, row);
      return filter === undefined
        ? "null::text"
        : filter === "true"
          ? `${row}.${id}::text`
          : `case when ${filter} then ${row}.${id}::text end`;
    },
    rows: (scope, options = {}) => {
      const where = [shape.holds(scope, "m") ?? "false"];
      if (options.id !== undefined) {
        where.push(`m.${id} = ${options.id}`);
      }
      const live =
        shape.expiresAt === undefined
          ? "true"
          : `(${col(shape.expiresAt)} is null or ${col(shape.expiresAt)} > now())`;
      const kept = where.filter((part) => part !== "true");
      return `select m.${id}::text as id, ${shape.userSql}::text as user_id, ${shape.roleKey} as role, ${shape.via} as via, ${live} as live
from ${options.from ?? qualified(shape.table)} m${shape.join}${shape.roleJoin}${kept.length === 0 ? "" : `\nwhere ${kept.join(" and ")}`}`;
    },
  };
}

function sqlOf(shape: Shape): MembershipSql {
  const suspension = shape.suspension;
  return compact<MembershipSql>({
    holders: holdersOf(shape),
    table: shape.table,
    user: shape.user,
    userThrough: shape.userThrough,
    userType:
      shape.userThrough === undefined
        ? `${qualified(shape.table)}.${ident(shape.user)}%type`
        : `${quoteSqlTable(shape.userThrough.table)}.${ident(shape.userThrough.key)}%type`,
    reads: [
      ...new Set(
        [suspension?.users, ...Object.values(suspension?.scopes ?? {})].flatMap(
          (row) => (row === undefined ? [] : [row.table]),
        ),
      ),
    ],
    managed: shape.managedColumn,
    through: shape.through,
    throughs: shape.throughs,
    columns: [...new Set(shape.columns)],
    manifest: {
      table: qualifiedName(shape.table),
      ...shape.manifest,
      columns: [...new Set(shape.columns)],
    },
    select: (user: string) =>
      selectOf(shape, filters(shape, `${shape.userSql} = ${user}`), false),
    list: () =>
      selectOf(
        shape,
        filters(shape, `${shape.scope} = $1::text and ${shape.id} = $2::text`),
        true,
      ),
  });
}

function isFixed(
  roles: MembershipJunctionOptions["roles"],
): roles is readonly string[] {
  return Array.isArray(roles);
}

/** A role column of the membership table, aliased `m`; a `through` column joins its roles table as `mk`. */
function memberRole(role: RoleSpec, table: string, label: string): RoleColumn {
  return roleColumn(role, qualifiedName(table), "m", { label, indent: "" });
}

/** The user of the membership table, aliased `m`; a `through` user joins its table as `mu`. */
function memberUser(
  user: string | RoleThrough,
  table: string,
  label: string,
): { readonly column: RoleColumn; readonly sql: string } {
  const column = roleColumn(user, qualifiedName(table), "m", {
    label,
    indent: "",
    joined: "mu",
    example: "{ contact_profile_id: 'id' }",
  });
  return {
    column,
    sql:
      column.through === undefined
        ? col(column.column)
        : `mu.${ident(column.through.key)}`,
  };
}

function roleAgg(role: RoleColumn): string {
  return `jsonb_agg(distinct ${role.sql} order by ${role.sql})`;
}

function rowsOf(
  result: Awaited<ReturnType<SqlQuery>>,
): readonly Record<string, unknown>[] {
  // SAFETY: SqlQuery's only other variant has rows; Array.isArray does not narrow readonly arrays.
  return Array.isArray(result)
    ? result
    : (result as { readonly rows: readonly Record<string, unknown>[] }).rows;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item !== "",
      )
    : [];
}

function membershipOf(row: Record<string, unknown>): Membership | undefined {
  const roles = strings(row["roles"]);
  if (typeof row["scope"] !== "string" || typeof row["id"] !== "string") {
    return undefined;
  }
  if (roles.length === 0) {
    return undefined;
  }
  // SAFETY: row['within'] is checked just before to be a non-null, non-array object.
  const within =
    row["within"] !== null &&
    typeof row["within"] === "object" &&
    !Array.isArray(row["within"])
      ? Object.fromEntries(
          Object.entries(row["within"] as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  const expires =
    typeof row["expires_at"] === "number"
      ? row["expires_at"]
      : typeof row["expires_at"] === "string" && row["expires_at"] !== ""
        ? Number(row["expires_at"])
        : undefined;
  const seats = strings(row["seats"]);
  return compact<Membership>({
    scope: row["scope"],
    id: row["id"],
    within:
      within === undefined || Object.keys(within).length === 0
        ? undefined
        : within,
    roles: [...roles].toSorted(),
    via: typeof row["via"] === "string" ? row["via"] : undefined,
    expiresAt: Number.isFinite(expires) ? expires : undefined,
    grantedBy:
      typeof row["granted_by"] === "string" && row["granted_by"] !== ""
        ? row["granted_by"]
        : undefined,
    reason:
      typeof row["reason"] === "string" && row["reason"] !== ""
        ? row["reason"]
        : undefined,
    member:
      typeof row["member_group"] === "string" && row["member_group"] !== ""
        ? { group: row["member_group"] }
        : undefined,
    managedBy: row["managed_by"] === "idp" ? "idp" : undefined,
    entitlements: seats.length === 0 ? undefined : seats,
  });
}

function sourceOf(
  sql: MembershipSql,
  query: SqlQuery | undefined,
): SqlMembershipSource {
  const run = async (
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]> => {
    if (query === undefined) {
      throw new TypeError(
        `PermDock: the ${sql.table} membership source needs query to resolve memberships`,
      );
    }
    return rowsOf(await query(text, values));
  };
  return {
    sql,
    async membershipsFor(principal) {
      const rows = await run(sql.select("$1"), [principal.id]);
      return rows.flatMap((row) => {
        const membership = membershipOf(row);
        return membership === undefined ? [] : [membership];
      });
    },
    async list(scope) {
      const rows = await run(sql.list(), [scope.scope, scope.id]);
      return rows.flatMap((row): MemberEntry[] => {
        const membership = membershipOf(row);
        return membership === undefined || typeof row["user_id"] !== "string"
          ? []
          : [{ principal: { id: row["user_id"] }, membership }];
      });
    },
  };
}

/**
 * Memberships from one table holding every scope: a row per user, scope,
 * instance and role (`user_id, scope, scope_id, role`), with optional
 * `within`, `via`, expiry, owner and seat columns. Rows of the same instance
 * merge into one membership.
 */
export function fromTable(
  options: MembershipTableOptions,
): SqlMembershipSource {
  const c = options.columns ?? {};
  const scope = `${col(c.scope ?? "scope")}::text`;
  const id = `${col(c.id ?? "scope_id")}::text`;
  const within = c.within === undefined ? "null::jsonb" : col(c.within);
  const optional = (name: string | undefined, cast: string): string =>
    name === undefined ? `null::${cast}` : `${col(name)}::${cast}`;
  const user = memberUser(
    c.user ?? "user_id",
    options.table,
    "fromTable columns.user",
  );
  const role = memberRole(
    c.role ?? "role",
    options.table,
    "fromTable columns.role",
  );
  const shape: Shape = {
    table: options.table,
    join: `${user.column.join}${role.join}`,
    through: role.through,
    throughs: role.throughs,
    user: user.column.column,
    userSql: user.sql,
    userThrough: user.column.through,
    scope,
    id,
    within,
    roles: roleAgg(role),
    via: optional(c.via, "text"),
    expiresAt: c.expiresAt,
    grantedBy: optional(c.grantedBy, "text"),
    reason: optional(c.reason, "text"),
    memberGroup: optional(c.group, "text"),
    managed: optional(c.managedBy, "text"),
    managedColumn: c.managedBy,
    seats: c.seats === undefined ? "null::jsonb" : `to_jsonb(${col(c.seats)})`,
    idOf: (name) =>
      `coalesce(case when ${scope} = ${literal(name)} then ${id} end${c.within === undefined ? "" : `, ${within} ->> ${literal(name)}`})`,
    idColumn: c.id ?? "scope_id",
    holds: (name, alias) =>
      `${alias}.${ident(c.scope ?? "scope")}::text = ${literal(name)}`,
    roleKey: role.sql,
    roleJoin: "",
    groupBy: [
      scope,
      id,
      ...(c.within === undefined ? [] : [within]),
      ...[
        c.via,
        c.expiresAt,
        c.grantedBy,
        c.reason,
        c.group,
        c.managedBy,
        c.seats,
      ]
        .filter((name): name is string => name !== undefined)
        .map(col),
    ],
    suspension: options.suspension,
    columns: [
      user.column.column,
      c.scope ?? "scope",
      c.id ?? "scope_id",
      ...role.columns,
      ...[c.within, c.via, c.expiresAt].filter(
        (name): name is string => name !== undefined,
      ),
    ],
    manifest: compact<Shape["manifest"]>({
      user: columnManifest(user.column),
      scope: { column: c.scope ?? "scope" },
      id: { column: c.id ?? "scope_id" },
      role: roleManifest(role),
      within: c.within === undefined ? undefined : { column: c.within },
      via: c.via === undefined ? undefined : { column: c.via },
      expiresAt:
        c.expiresAt === undefined ? undefined : { column: c.expiresAt },
    }),
  };
  return sourceOf(sqlOf(shape), options.query);
}

/**
 * Memberships from a table of one scope (`customer_contacts`): every row is a
 * membership of `scope`, with roles from a column or fixed (`['contact']`), a
 * fixed `via`, and ancestor ids from `within` columns.
 */
export function fromJunction(
  options: MembershipJunctionOptions,
): SqlMembershipSource {
  if (!/^[a-z][a-z0-9_]*$/u.test(options.scope)) {
    throw new TypeError(`PermDock: unsafe scope name '${options.scope}'`);
  }
  const idColumn = options.id ?? `${options.scope}_id`;
  const withinEntries = Object.entries(options.within ?? {});
  const roles = options.roles;
  const fixed = isFixed(roles) ? roles : undefined;
  if (fixed?.length === 0) {
    throw new TypeError("PermDock: fromJunction needs at least one role");
  }
  const role = isFixed(roles)
    ? undefined
    : memberRole(
        typeof roles === "object" && "sources" in roles ? roles.sources : roles,
        options.table,
        "fromJunction roles",
      );
  const user = memberUser(
    options.user ?? "user_id",
    options.table,
    "fromJunction user",
  );
  const managedColumn =
    options.managedBy === undefined
      ? undefined
      : options.managedBy === "idp"
        ? ""
        : options.managedBy.column;
  const groupColumn =
    options.group === undefined || typeof options.group === "string"
      ? undefined
      : options.group.column;
  const shape: Shape = {
    table: options.table,
    join: `${user.column.join}${role?.join ?? ""}`,
    through: role?.through,
    throughs: role?.throughs ?? [],
    user: user.column.column,
    userSql: user.sql,
    userThrough: user.column.through,
    scope: `${literal(options.scope)}::text`,
    id: `${col(idColumn)}::text`,
    within:
      withinEntries.length === 0
        ? "null::jsonb"
        : `jsonb_build_object(${withinEntries.map(([name, column]) => `${literal(name)}, ${col(column)}::text`).join(", ")})`,
    roles:
      role === undefined
        ? `jsonb_build_array(${(fixed ?? []).map(literal).join(", ")})`
        : roleAgg(role),
    via:
      options.via === undefined
        ? "null::text"
        : `${literal(options.via)}::text`,
    expiresAt: options.expiresAt,
    grantedBy:
      options.grantedBy === undefined
        ? "null::text"
        : `${col(options.grantedBy)}::text`,
    reason:
      options.reason === undefined
        ? "null::text"
        : `${col(options.reason)}::text`,
    memberGroup:
      options.group === undefined
        ? "null::text"
        : typeof options.group === "string"
          ? `${literal(options.group)}::text`
          : `${col(options.group.column)}::text`,
    managed:
      managedColumn === undefined
        ? "null::text"
        : managedColumn === ""
          ? `'idp'::text`
          : `${col(managedColumn)}::text`,
    managedColumn,
    seats:
      options.seats === undefined
        ? "null::jsonb"
        : `to_jsonb(${col(options.seats)})`,
    idColumn,
    holds: (name) => (name === options.scope ? "true" : undefined),
    roleKey: role === undefined ? "mf.role" : role.sql,
    roleJoin:
      role === undefined
        ? ` cross join lateral unnest(array[${(fixed ?? []).map(literal).join(", ")}]::text[]) mf(role)`
        : "",
    idOf: (name) => {
      if (name === options.scope) {
        return `${col(idColumn)}::text`;
      }
      const column = options.within?.[name];
      return column === undefined ? undefined : `${col(column)}::text`;
    },
    groupBy: [
      col(idColumn),
      ...withinEntries.map(([, column]) => col(column)),
      ...[
        options.expiresAt,
        options.grantedBy,
        options.reason,
        groupColumn,
        managedColumn === "" ? undefined : managedColumn,
        options.seats,
      ]
        .filter((name): name is string => name !== undefined)
        .map(col),
    ],
    suspension: options.suspension,
    columns: [
      user.column.column,
      idColumn,
      ...withinEntries.map(([, column]) => column),
      ...(role?.columns ?? []),
      ...[options.expiresAt].filter(
        (name): name is string => name !== undefined,
      ),
    ],
    manifest: compact<Shape["manifest"]>({
      user: columnManifest(user.column),
      scope: { value: options.scope },
      id: { column: idColumn },
      role:
        role === undefined ? { value: [...(fixed ?? [])] } : roleManifest(role),
      within:
        withinEntries.length === 0
          ? undefined
          : { columns: Object.fromEntries(withinEntries) },
      via: options.via === undefined ? undefined : { value: options.via },
      expiresAt:
        options.expiresAt === undefined
          ? undefined
          : { column: options.expiresAt },
    }),
  };
  const sql = sqlOf(shape);
  return sourceOf(
    {
      ...sql,
      scope: options.scope,
      holds: [options.scope, ...withinEntries.map(([name]) => name)],
      list: () =>
        selectOf(
          shape,
          filters(
            shape,
            `$1::text = ${literal(options.scope)} and ${col(idColumn)}::text = $2::text`,
          ),
          true,
        ),
    },
    options.query,
  );
}

export const AUTHZ_VERSION_TABLE = "permdock_authz_version";

/**
 * The default schema of everything PermDock generates: helpers, seeds, the
 * RBAC scaffold, the hook and the version table. Keep it out of the Data
 * API's exposed schemas, so the `security definer` functions are not RPCs.
 */
export const PERMDOCK_SCHEMA = "permdock";

export { supabaseMembershipsBudget, supabaseTenantClaim } from "./budget.ts";

/**
 * Reads the authorization version `permdock supabase hook generate` keeps in
 * `<schema>.permdock_authz_version`: pass it to `claimsFirst(sources, { version })`.
 */
export function authzVersion(options: {
  readonly query: SqlQuery;
  readonly schema?: string;
}): NonNullable<MembershipSource["version"]> {
  const table = qualified(
    `${options.schema ?? PERMDOCK_SCHEMA}.${AUTHZ_VERSION_TABLE}`,
  );
  return async (principal) => {
    const rows = rowsOf(
      await options.query(`select version from ${table} where user_id = $1`, [
        principal.id,
      ]),
    );
    const value = rows[0]?.["version"];
    const version =
      typeof value === "number"
        ? value
        : value === undefined
          ? 0
          : Number(value);
    return Number.isFinite(version) ? version : undefined;
  };
}
