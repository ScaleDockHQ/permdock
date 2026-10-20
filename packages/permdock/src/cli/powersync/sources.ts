import type { RoleSource, RoleSpec } from "../../supabase/roles.ts";
import type {
  MembershipStream,
  SqlMembershipSource,
} from "../../supabase/sources.ts";
import type { RoleThrough } from "../../supabase/types.ts";
import type { StreamDialect } from "./streams.ts";

import { bare } from "./names.ts";

export type SourceCtx = {
  readonly dialect: StreamDialect;
  readonly kinds: Readonly<Record<string, readonly string[]>>;
};

type Alternatives = readonly (readonly string[])[];

/** The tables a query reads and the filters that keep the user's own rows of one source. */
export type OwnRows = {
  readonly table: string;
  readonly from: string;
  readonly where: readonly string[];
};

/** The sources that can hold scope `name`: every table source and the junction sources of that scope. */
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
    return `the ${source.sql.table} membership source has no stream form: build it with tableMembershipSource or junctionMembershipSource`;
  }
  if (stream.expiresAt !== undefined) {
    return `the ${stream.table} membership source has no stream: it has an expiry`;
  }
  if (stream.disabledAt !== undefined) {
    return `the ${stream.table} membership source has no stream: it has disabledAt`;
  }
  return stream;
}

function pairOf(through: RoleThrough): readonly [string, string] {
  const [pair] = Object.entries(through.on);
  if (pair === undefined) {
    throw new TypeError(
      `PermDock CLI: the reference to ${through.through} names no column`,
    );
  }
  return pair;
}

function isFixed(
  roles: MembershipStream["roles"],
): roles is { readonly value: readonly string[] } {
  return typeof roles === "object" && "value" in roles;
}

function isSourceList(roles: RoleSpec): roles is readonly RoleSource[] {
  return Array.isArray(roles);
}

function roleSources(roles: RoleSpec): readonly RoleSource[] {
  return isSourceList(roles) ? roles : [roles];
}

function anyOf(clauses: readonly string[]): string {
  return clauses.length === 1
    ? (clauses[0] ?? "")
    : `(${clauses.join(" OR ")})`;
}

/** The user's own rows of the source, of scope `scope` when the source has a scope column. */
export function ownRows(
  stream: MembershipStream,
  dialect: StreamDialect,
  scope?: string,
): OwnRows {
  const table = bare(stream.table);
  const scoped =
    scope !== undefined && "column" in stream.scope
      ? [
          `${dialect.column(table, stream.scope.column)} = ${dialect.literal(scope)}`,
        ]
      : [];
  if (typeof stream.user === "string") {
    return {
      table,
      from: table,
      where: [
        `${dialect.column(table, stream.user)} = ${dialect.user}`,
        ...scoped,
      ],
    };
  }
  const users = bare(stream.user.through);
  const [ref, id] = pairOf(stream.user);
  return {
    table,
    from: `${table} INNER JOIN ${users} ON ${dialect.column(users, id)} = ${dialect.column(table, ref)}`,
    where: [
      `${dialect.column(users, stream.user.column)} = ${dialect.user}`,
      ...scoped,
    ],
  };
}

/** The filter of one role source for role `role`; `undefined` when the source never holds it. */
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
  const keys = bare(source.through);
  const [ref, id] = pairOf(source);
  const { guard } = stream;
  const guarded =
    guard !== undefined &&
    bare(guard.table) === keys &&
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
    join: ` INNER JOIN ${keys} ON ${dialect.column(keys, id)} = ${dialect.column(table, ref)}`,
    where: [
      `${dialect.column(keys, source.column)} = ${dialect.literal(role)}`,
      ...guarded,
    ].join(" AND "),
  };
}

/** The kinds filter of role `role`: `[]` for none, `undefined` when no row of the source has one of its kinds. */
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
 */
export function sourceIn(
  stream: MembershipStream,
  scope: string,
  left: string,
  roles: readonly string[],
  ctx: SourceCtx,
): Alternatives {
  const own = ownRows(stream, ctx.dialect, scope);
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

/** The roles tables the source joins through, each with the query of the rows the user's own rows reference. */
export function roleTableRows(
  stream: MembershipStream,
  dialect: StreamDialect,
): readonly { readonly table: string; readonly query: string }[] {
  if (isFixed(stream.roles)) {
    return [];
  }
  const own = ownRows(stream, dialect);
  return roleSources(stream.roles).flatMap((source) => {
    if (typeof source === "string" || "map" in source) {
      return [];
    }
    const keys = bare(source.through);
    const [ref, id] = pairOf(source);
    return [
      {
        table: keys,
        query: `SELECT * FROM ${keys} WHERE ${dialect.column(keys, id)} IN (SELECT ${dialect.column(own.table, ref)} FROM ${own.from} WHERE ${own.where.join(" AND ")})`,
      },
    ];
  });
}
