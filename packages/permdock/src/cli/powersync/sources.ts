import type { RoleSource, RoleSpec } from "../../supabase/roles.ts";
import type {
  MembershipStream,
  SqlMembershipSource,
} from "../../supabase/sources.ts";
import type { RoleThrough } from "../../supabase/types.ts";
import type { StreamDialect } from "./streams.ts";

import { bare, fromTable } from "./names.ts";

export type SourceCtx = {
  readonly dialect: StreamDialect;
  readonly kinds: Readonly<Record<string, readonly string[]>>;
};

type Alternatives = readonly (readonly string[])[];

/**
 * The tables a query reads and the filters that keep the user's own rows of one
 * source.
 */
export type OwnRows = {
  readonly table: string;
  readonly from: string;
  readonly where: readonly string[];
};

/**
 * The sources that can hold scope `name`: every table source and the junction
 * sources of that scope.
 */
export function scopeSourcesOf(
  sources: readonly SqlMembershipSource[],
  name: string,
): readonly SqlMembershipSource[] {
  return sources.filter(
    (source) => source.sql.scope === undefined || source.sql.scope === name,
  );
}

/** The source's stream form, or why its rows cannot filter a stream. */
export function streamOf(
  source: SqlMembershipSource,
): MembershipStream | string {
  const { stream } = source.sql;
  if (stream === undefined) {
    return `the ${source.sql.table} membership source has no stream form: build it with tableMembershipSource, junctionMembershipSource or blockMembershipSource`;
  }
  if (stream.expiresAt !== undefined) {
    return `the ${stream.table} membership source has no stream: it has an expiry`;
  }
  return stream;
}

/**
 * Every `on` pair of the reference: the referencing column, then the column of
 * `through` it references. A composite key (`organization_id` and `user_id`)
 * matches only when every pair does.
 */
export function pairsOf(
  through: RoleThrough,
): readonly (readonly [string, string])[] {
  const pairs = Object.entries(through.on);
  if (pairs.length === 0) {
    throw new TypeError(
      `PermDock CLI: the reference to ${through.through} names no column`,
    );
  }
  return pairs;
}

/** The `ON` of a join from `table` to `keys`, the bare name of `through`. */
export function joinOn(
  through: RoleThrough,
  keys: string,
  table: string,
  dialect: StreamDialect,
): string {
  return pairsOf(through)
    .map(
      ([ref, id]) =>
        `${dialect.column(keys, id)} = ${dialect.column(table, ref)}`,
    )
    .join(" AND ");
}

/**
 * The select list of a `through` row. PowerSync keys every synced row on an
 * `id` column, so a composite reference selects its key columns and the value
 * column with `id` built from them; a single reference keeps `*`.
 */
export function throughSelect(
  through: RoleThrough,
  keys: string,
  dialect: StreamDialect,
): string {
  const pairs = pairsOf(through);
  if (pairs.length === 1) {
    return "*";
  }
  const columns = [
    ...new Set([...pairs.map(([, id]) => id), through.column]),
  ].map((column) => dialect.column(keys, column));
  return `${columns.join(", ")}, ${columns.join(` || ${dialect.literal(":")} || `)} AS id`;
}

/**
 * The query of the `through` rows the user's own rows reference. A pair on the
 * user column compares with the signed-in user, so a composite junction keyed
 * on the tenant and the user syncs only the user's rows; `user` then names the
 * junction's user column.
 */
export function throughRows(
  through: RoleThrough,
  own: OwnRows,
  dialect: StreamDialect,
  ownUser?: string,
): { readonly table: string; readonly query: string; readonly user?: string } {
  const keys = bare(through.through, dialect);
  const pairs = pairsOf(through);
  const user = pairs.find(([ref]) => ref === ownUser)?.[1];
  const where = pairs.flatMap(([ref, id]) => {
    const owned = `${dialect.column(keys, id)} IN (SELECT ${dialect.column(own.table, ref)} FROM ${own.from} WHERE ${own.where.join(" AND ")})`;
    if (id !== user) {
      return [owned];
    }
    const mine = `${dialect.column(keys, id)} = ${dialect.user}`;
    return pairs.length === 1 ? [mine, owned] : [mine];
  });
  const query = `SELECT ${throughSelect(through, keys, dialect)} FROM ${fromTable(through.through, dialect)} WHERE ${where.join(" AND ")}`;
  return user === undefined
    ? { table: keys, query }
    : { table: keys, query, user };
}

export function isFixed(
  roles: MembershipStream["roles"],
): roles is { readonly value: readonly string[] } {
  return typeof roles === "object" && "value" in roles;
}

function isSourceList(roles: RoleSpec): roles is readonly RoleSource[] {
  return Array.isArray(roles);
}

export function roleSources(roles: RoleSpec): readonly RoleSource[] {
  return isSourceList(roles) ? roles : [roles];
}

function anyOf(clauses: readonly string[]): string {
  return clauses.length === 1
    ? (clauses[0] ?? "")
    : `(${clauses.join(" OR ")})`;
}

/**
 * The user's own rows of the source, of scope `scope` when the source has a
 * scope column. `keep` drops the suspension filter: the grant keeps a suspended
 * membership.
 */
export function ownRows(
  stream: MembershipStream,
  dialect: StreamDialect,
  scope?: string,
  keep = false,
): OwnRows {
  const table = bare(stream.table, dialect);
  const scoped =
    scope !== undefined && "column" in stream.scope
      ? [
          `${dialect.column(table, stream.scope.column)} = ${dialect.literal(scope)}`,
        ]
      : [];
  const suspended =
    !keep && stream.disabledAt !== undefined
      ? [`${dialect.column(table, stream.disabledAt)} IS NULL`]
      : [];
  if (typeof stream.user === "string") {
    return {
      table,
      from: fromTable(stream.table, dialect),
      where: [
        `${dialect.column(table, stream.user)} = ${dialect.user}`,
        ...scoped,
        ...suspended,
      ],
    };
  }
  const users = bare(stream.user.through, dialect);
  return {
    table,
    from: `${fromTable(stream.table, dialect)} INNER JOIN ${fromTable(stream.user.through, dialect)} ON ${joinOn(stream.user, users, table, dialect)}`,
    where: [
      `${dialect.column(users, stream.user.column)} = ${dialect.user}`,
      ...scoped,
      ...suspended,
    ],
  };
}

/**
 * The filter of one role source for role `role`; `undefined` when the source
 * never holds it.
 */
function roleFilter(
  stream: MembershipStream,
  source: RoleSource,
  role: string,
  table: string,
  dialect: StreamDialect,
): { readonly join: string; readonly where: string } | undefined {
  if (typeof source === "string") {
    return {
      join: "",
      where: `${dialect.column(table, source)} = ${dialect.literal(role)}`,
    };
  }
  if ("map" in source) {
    const values = Object.entries(source.map)
      .filter(([, key]) => key === role)
      .map(
        ([value]) =>
          `${dialect.column(table, source.column)} = ${dialect.literal(value)}`,
      );
    return values.length === 0 ? undefined : { join: "", where: anyOf(values) };
  }
  const keys = bare(source.through, dialect);
  const { guard } = stream;
  const guarded =
    guard !== undefined &&
    bare(guard.table, dialect) === keys &&
    guard.declared.includes(role)
      ? [
          anyOf([
            `${dialect.column(keys, guard.tenant)} IS NULL`,
            ...(guard.skip === undefined
              ? []
              : [
                  `${dialect.column(keys, guard.skip)} = ${dialect.literal(true)}`,
                ]),
          ]),
        ]
      : [];
  return {
    join: ` INNER JOIN ${fromTable(source.through, dialect)} ON ${joinOn(source, keys, table, dialect)}`,
    where: [
      `${dialect.column(keys, source.column)} = ${dialect.literal(role)}`,
      ...guarded,
    ].join(" AND "),
  };
}

/**
 * The kinds filter of role `role`: `[]` for none, `undefined` when no row of
 * the source has one of its kinds.
 */
function kindFilter(
  stream: MembershipStream,
  role: string,
  table: string,
  ctx: SourceCtx,
): readonly string[] | undefined {
  const kinds = ctx.kinds[role];
  if (kinds === undefined) {
    return [];
  }
  const { via } = stream;
  if (via === undefined) {
    return undefined;
  }
  if ("value" in via) {
    return kinds.includes(via.value) ? [] : undefined;
  }
  return kinds.length === 0
    ? undefined
    : [
        anyOf(
          kinds.map(
            (kind) =>
              `${ctx.dialect.column(table, via.column)} = ${ctx.dialect.literal(kind)}`,
          ),
        ),
      ];
}

/**
 * One `IN (SELECT …)` per role source of the stream that can hold one of
 * `roles` in scope `scope`: the row's `left` is an instance the user holds it
 * in. A null role never equals a key, so a row without a role grants nothing.
 * `keep` drops the suspension filter of a membership the grant keeps.
 */
export function sourceIn(
  stream: MembershipStream,
  scope: string,
  left: string,
  roles: readonly string[],
  ctx: SourceCtx,
  keep = false,
): Alternatives {
  const own = ownRows(stream, ctx.dialect, scope, keep);
  const select = (join: string, filters: readonly string[]): string =>
    `${left} IN (SELECT ${ctx.dialect.column(own.table, stream.id)} FROM ${own.from}${join} WHERE ${[...own.where, ...filters].join(" AND ")})`;
  const out: string[][] = [];
  for (const role of roles) {
    const kinds = kindFilter(stream, role, own.table, ctx);
    if (kinds === undefined) {
      continue;
    }
    if (isFixed(stream.roles)) {
      if (stream.roles.value.includes(role)) {
        out.push([select("", kinds)]);
      }
      continue;
    }
    for (const source of roleSources(stream.roles)) {
      const filter = roleFilter(stream, source, role, own.table, ctx.dialect);
      if (filter !== undefined) {
        out.push([select(filter.join, [...kinds, filter.where])]);
      }
    }
  }
  return out;
}

/**
 * The roles tables the source joins through, each with the query of the rows
 * the user's own rows reference.
 */
export function roleTableRows(
  stream: MembershipStream,
  dialect: StreamDialect,
  keep = false,
): readonly {
  readonly table: string;
  readonly query: string;
  readonly user?: string;
}[] {
  if (isFixed(stream.roles)) {
    return [];
  }
  const own = ownRows(stream, dialect, undefined, keep);
  const user = typeof stream.user === "string" ? stream.user : undefined;
  return roleSources(stream.roles).flatMap((source) =>
    typeof source === "string" || "map" in source
      ? []
      : [throughRows(source, own, dialect, user)],
  );
}
