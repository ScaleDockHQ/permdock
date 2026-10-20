import type { SupabaseManifestMembership } from "./manifest.ts";
import type { RoleKeys } from "./roles.ts";
import type { MembershipHolders, MembershipSql } from "./sources.ts";
import type { SupabaseActiveRow, SupabaseSuspension } from "./types.ts";

import { compact } from "../core/compact.ts";
import {
  qualifySqlTable,
  quoteQualifiedTable,
  quoteSqlIdent,
  quoteSqlLiteral,
  quoteSqlTable,
  sqlTextArray,
} from "../core/sql.ts";
import { keptKeys } from "./keep.ts";

const ident = (name: string): string => quoteSqlIdent(name);
const literal = quoteSqlLiteral;

export function col(name: string): string {
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
  return `exists (select 1 from ${quoteQualifiedTable(row.table)} s where ${parts.join(" and ")})`;
}

export type Shape = {
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
  readonly disabledAt: string | undefined;
  readonly grantedBy: string;
  readonly reason: string;
  readonly memberGroup: string;
  readonly managed: string;
  readonly managedColumn: string | undefined;
  readonly seats: string;
  readonly x: string | undefined;
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

/**
 * The suspendable instances on the row's chain whose scope keeps
 * permissions: each one's active check and its kept keys.
 */
function keeping(
  shape: Shape,
): readonly { readonly active: string; readonly keep: readonly string[] }[] {
  const scopes = Object.entries(shape.suspension?.scopes ?? {}).flatMap(
    ([name, row]) => {
      const id = shape.idOf(name);
      const keep = keptKeys(row);
      return id === undefined || keep.length === 0
        ? []
        : [{ active: `(${id} is null or ${activeRow(row, id)})`, keep }];
    },
  );
  const keep = keptKeys(shape.suspension?.memberships);
  return shape.disabledAt === undefined || keep.length === 0
    ? scopes
    : [...scopes, { active: enabled(shape.disabledAt), keep }];
}

function enabled(disabledAt: string): string {
  return `${col(disabledAt)} is null`;
}

function keepsDisabled(shape: Shape): boolean {
  return (
    shape.disabledAt !== undefined &&
    keptKeys(shape.suspension?.memberships).length > 0
  );
}

/**
 * The keys a row on a suspended chain still grants, as a sorted `jsonb`
 * array: the keys every suspended instance on it keeps. `null` when nothing
 * is kept.
 */
function keptSql(shape: Shape): string | undefined {
  const list = keeping(shape);
  if (list.length === 0) {
    return undefined;
  }
  const keys = [...new Set(list.flatMap((item) => item.keep))].toSorted();
  const each = list
    .map((item) => `(${item.active} or k = any(${sqlTextArray(item.keep)}))`)
    .join(" and ");
  return `(select jsonb_agg(k order by k) from unnest(${sqlTextArray(keys)}) k where ${each})`;
}

function allActive(shape: Shape): string {
  return keeping(shape)
    .map((item) => item.active)
    .join(" and ");
}

export function filters(shape: Shape, owner: string): string[] {
  const lines = [owner];
  if (shape.expiresAt !== undefined) {
    const expires = col(shape.expiresAt);
    lines.push(`(${expires} is null or ${expires} > now())`);
  }
  if (shape.disabledAt !== undefined && !keepsDisabled(shape)) {
    lines.push(enabled(shape.disabledAt));
  }
  const users = shape.suspension?.users;
  if (users !== undefined) {
    lines.push(activeRow(users, shape.userSql));
  }
  for (const [name, row] of Object.entries(shape.suspension?.scopes ?? {})) {
    const id = shape.idOf(name);
    if (id !== undefined && keptKeys(row).length === 0) {
      lines.push(`(${id} is null or ${activeRow(row, id)})`);
    }
  }
  const kept = keptSql(shape);
  if (kept !== undefined) {
    lines.push(`(${allActive(shape)} or ${kept} is not null)`);
  }
  return lines;
}

function keepColumn(shape: Shape): string {
  const kept = keptSql(shape);
  return kept === undefined
    ? "null::jsonb"
    : `(array_agg(case when ${allActive(shape)} then null else ${kept} end))[1]`;
}

export function selectOf(
  shape: Shape,
  where: readonly string[],
  user: boolean,
  keep: boolean,
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
    ...(shape.x === undefined ? [] : [`${col(shape.x)} as x`]),
    ...(keep ? [`${keepColumn(shape)} as keep`] : []),
  ];
  const group = [
    ...(user ? [shape.userSql] : []),
    ...shape.groupBy,
    ...(keepsDisabled(shape) && shape.disabledAt !== undefined
      ? [`(${enabled(shape.disabledAt)})`]
      : []),
  ];
  return `select ${fields.join(", ")}
from ${quoteQualifiedTable(shape.table)} m${shape.join}
where ${where.join("\n  and ")}
group by ${group.join(", ")}
having ${shape.roles} is not null`;
}

function holdersOf(shape: Shape): MembershipHolders {
  const id = ident(shape.idColumn);
  return {
    idType: `${quoteQualifiedTable(shape.table)}.${id}%type`,
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
      const conditions = [
        ...(shape.expiresAt === undefined
          ? []
          : [
              `(${col(shape.expiresAt)} is null or ${col(shape.expiresAt)} > now())`,
            ]),
        ...(shape.disabledAt === undefined ? [] : [enabled(shape.disabledAt)]),
      ];
      const live =
        conditions.length === 0
          ? "true"
          : conditions.length === 1
            ? conditions.join("")
            : `(${conditions.join(" and ")})`;
      const kept = where.filter((part) => part !== "true");
      return `select m.${id}::text as id, ${shape.userSql}::text as user_id, ${shape.roleKey} as role, ${shape.via} as via, ${live} as live
from ${options.from ?? quoteQualifiedTable(shape.table)} m${shape.join}${shape.roleJoin}${kept.length === 0 ? "" : `\nwhere ${kept.join(" and ")}`}`;
    },
  };
}

export function sqlOf(shape: Shape): MembershipSql {
  const suspension = shape.suspension;
  return compact<MembershipSql>({
    holders: holdersOf(shape),
    table: shape.table,
    user: shape.user,
    userThrough: shape.userThrough,
    userType:
      shape.userThrough === undefined
        ? `${quoteQualifiedTable(shape.table)}.${ident(shape.user)}%type`
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
      table: qualifySqlTable(shape.table),
      ...shape.manifest,
      columns: [...new Set(shape.columns)],
    },
    keeps: keptSql(shape) !== undefined,
    select: (user: string, keep = keptSql(shape) !== undefined) =>
      selectOf(
        shape,
        filters(shape, `${shape.userSql} = ${user}`),
        false,
        keep,
      ),
    list: (keep = keptSql(shape) !== undefined) =>
      selectOf(
        shape,
        filters(shape, `${shape.scope} = $1::text and ${shape.id} = $2::text`),
        true,
        keep,
      ),
  });
}
