import type { RelatedCondition } from "../../conditions/ast.ts";
import type { Condition, ConditionValue } from "../../index.ts";
import type { RoleSource } from "../../supabase/roles.ts";
import type { RlsGrant } from "../sql/grants.ts";
import type { RlsMembershipTable } from "../types.ts";
import type { StreamCtx } from "./stream-types.ts";

import { isConditionDate, isConditionRef } from "../../conditions/ast.ts";
import { scopeColumn, scopeMembershipTable } from "../../conditions/compile.ts";
import { resolveScope } from "../../core/scopes.ts";
import { SQL_IDENT } from "../../core/sql.ts";
import { requiresApproval } from "../../index.ts";
import { keptKeys } from "../../supabase/keep.ts";
import { tableFor } from "../sql/compile.ts";
import { contextRefs } from "../sql/conditions.ts";
import { tableNames } from "../sql/tables.ts";
import { customRoleItems } from "./levels.ts";
import { bare, fromTable } from "./names.ts";
import { joinOn, scopeSourcesOf, sourceIn, streamOf } from "./sources.ts";

type Ctx = StreamCtx;

/** Why a grant cannot become a stream query, before its conditions are compiled. */
export function unsupported(item: RlsGrant): string | undefined {
  const { grant } = item;
  if (grant.breakGlass !== undefined) {
    return "break-glass";
  }
  if (grant.closure !== undefined || grant.portable === false) {
    return "not portable";
  }
  if (requiresApproval(grant.approval)) {
    return "needs approval";
  }
  if (grant.validity !== undefined) {
    return "time-bounded";
  }
  const context = contextRefs(item.where);
  return context.length > 0 ? `reads ${context.join(", ")}` : undefined;
}

/** Nested `inherit()` grants a stream follows; a longer chain syncs nothing. */
const MAX_INHERIT_DEPTH = 4;

/** Every combination of one clause list from each input, ANDed. */
export function product(
  lists: readonly (readonly (readonly string[])[])[],
): readonly (readonly string[])[] {
  let out: readonly (readonly string[])[] = [[]];
  for (const list of lists) {
    out = out.flatMap((left) => list.map((right) => left.concat(right)));
  }
  return out;
}

function every<T>(parts: readonly (T | undefined)[]): readonly T[] | undefined {
  const out: T[] = [];
  for (const part of parts) {
    if (part === undefined) {
      return undefined;
    }
    out.push(part);
  }
  return out;
}

/**
 * A row value: a literal, or a principal ref the token carries. `undefined`
 * when neither.
 */
function valueSql(value: ConditionValue, ctx: Ctx): string | undefined {
  if (isConditionRef(value)) {
    if (value.ref === "principal.id") {
      return ctx.dialect.user;
    }
    const claim = /^principal\.claims\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(
      value.ref,
    )?.[1];
    return claim === undefined ? undefined : ctx.dialect.claim(claim);
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return ctx.dialect.literal(value);
  }
  return undefined;
}

const COMPARE = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
} as const;

/**
 * A row condition as alternatives of ANDed clauses over `table`. `undefined`
 * when part of it has no Sync Streams form, so the grant syncs nothing.
 */
export function conditionSql(
  condition: Condition,
  table: string,
  ctx: Ctx,
  permission?: string,
): readonly (readonly string[])[] | undefined {
  const column = (field: string): string | undefined =>
    SQL_IDENT.test(field) ? ctx.dialect.column(table, field) : undefined;
  switch (condition.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left =
        typeof condition.value === "number" && SQL_IDENT.test(condition.field)
          ? ctx.dialect.column(table, condition.field, true)
          : column(condition.field);
      if (condition.value === null && left !== undefined) {
        return condition.op === "eq"
          ? [[`${left} IS NULL`]]
          : condition.op === "ne"
            ? [[`${left} IS NOT NULL`]]
            : undefined;
      }
      const right = valueSql(condition.value, ctx);
      return left === undefined || right === undefined
        ? undefined
        : [[`${left} ${COMPARE[condition.op]} ${right}`]];
    }
    case "isNull": {
      const left = column(condition.field);
      return left === undefined
        ? undefined
        : [[`${left} IS ${condition.value ? "" : "NOT "}NULL`]];
    }
    case "in":
    case "notIn": {
      const left = column(condition.field);
      if (left === undefined) {
        return undefined;
      }
      const negate = condition.op === "notIn" ? "NOT " : "";
      if (isConditionRef(condition.value)) {
        const claim = /^principal\.claims\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(
          condition.value.ref,
        )?.[1];
        return claim === undefined || negate !== ""
          ? undefined
          : [[`${left} IN ${ctx.dialect.claims(claim)}`]];
      }
      const values = condition.value.map((value) =>
        isConditionRef(value) || isConditionDate(value) || Array.isArray(value)
          ? undefined
          : value === null
            ? undefined
            : valueSql(value, ctx),
      );
      if (values.some((value) => value === undefined)) {
        return undefined;
      }
      return values.length === 0
        ? negate === ""
          ? []
          : [[]]
        : [[`${left} ${negate}IN (${values.join(", ")})`]];
    }
    case "and":
    case "or": {
      const parts = every(
        condition.conditions.map((child) =>
          conditionSql(child, table, ctx, permission),
        ),
      );
      if (parts === undefined) {
        return undefined;
      }
      return condition.op === "and" ? product(parts) : parts.flat();
    }
    case "memberOf": {
      if (condition.scope === "resource" || condition.parents !== undefined) {
        return undefined;
      }
      const scope = resolveScope(ctx.scopes, condition.scope);
      const left = column(condition.field);
      if (scope === undefined || left === undefined) {
        return undefined;
      }
      return membershipSql(scope, left, condition.roles, ctx, permission);
    }
    case "sqlFunction":
      return conditionSql(condition.twin, table, ctx, permission);
    case "related":
      return relatedSql(condition, table, ctx);
    case "not":
    case "contains":
    case "opaque":
    case "liveSession":
      return undefined;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/**
 * An `inherit()` condition: the row's `field` among the ids of the `resource`
 * rows the user reaches with `permission`, one nested `IN (SELECT …)` per link
 * hop. A relation reads the closure table, which Sync Streams cannot.
 */
function relatedSql(
  condition: RelatedCondition,
  table: string,
  ctx: Ctx,
): readonly (readonly string[])[] | undefined {
  const { permission } = condition;
  if (
    permission === undefined ||
    condition.relation !== "" ||
    condition.ids !== undefined ||
    condition.depth > 0 ||
    condition.restrictedAncestors !== undefined ||
    ctx.depth >= MAX_INHERIT_DEPTH ||
    !SQL_IDENT.test(condition.field)
  ) {
    return undefined;
  }
  let ids = permittedSql(condition.resource, permission, {
    ...ctx,
    depth: ctx.depth + 1,
  });
  const hops = condition.hops ?? [];
  for (
    let index = hops.length - 1;
    index > 0 && ids !== undefined;
    index -= 1
  ) {
    const hop = hops[index];
    const node = ctx.policy.resources.get(hops[index - 1]?.resource ?? "");
    const link =
      hop !== undefined &&
      node !== undefined &&
      Object.hasOwn(node.links, hop.link)
        ? node.links[hop.link]
        : undefined;
    if (
      node === undefined ||
      link === undefined ||
      !SQL_IDENT.test(node.id) ||
      !SQL_IDENT.test(link.field)
    ) {
      return undefined;
    }
    const source = tableFor(node.name, tableNames(ctx.config.rls?.tables));
    const name = bare(source, ctx.dialect);
    ids = ids.map(
      (query) =>
        `SELECT ${ctx.dialect.column(name, node.id)} FROM ${fromTable(source, ctx.dialect)} WHERE ${ctx.dialect.column(name, link.field)} IN (${query})`,
    );
  }
  const open =
    condition.restricted === undefined
      ? [[]]
      : conditionSql(
          {
            op: "or",
            conditions: [
              { op: "isNull", field: condition.restricted, value: true },
              { op: "eq", field: condition.restricted, value: false },
            ],
          },
          table,
          ctx,
        );
  if (ids === undefined || open === undefined) {
    return undefined;
  }
  const left = ctx.dialect.column(table, condition.field);
  return product([ids.map((query) => [`${left} IN (${query})`]), open]);
}

/**
 * The `SELECT`s of the ids of the `resource` rows the user reaches with `key`:
 * `[]` when no grant gives it, `undefined` when a deny grant could subtract
 * rows or no grant compiles. A grant that does not compile leaves its rows out,
 * which the caller reports as an under-sync.
 */
export function permittedSql(
  resource: string,
  key: string,
  ctx: Ctx,
): readonly string[] | undefined {
  const node = ctx.policy.resources.get(resource);
  const items = ctx.grants.filter((item) => item.grant.permission.key === key);
  if (
    node === undefined ||
    !SQL_IDENT.test(node.id) ||
    items.some((item) => item.grant.effect === "deny")
  ) {
    return undefined;
  }
  const source = tableFor(resource, tableNames(ctx.config.rls?.tables));
  const table = bare(source, ctx.dialect);
  const custom = customRoleItems(ctx, ctx.grants, resource, key, table);
  if (custom.skipped !== undefined) {
    ctx.gaps.push(custom.skipped);
  }
  const reaches = [
    ...items.map((item) => ({
      item,
      access: unsupported(item) ?? accessSql(item, table, ctx),
    })),
    ...custom.items.map((entry) => ({
      item: entry.item,
      access: entry.access,
    })),
  ];
  const queries = new Set<string>();
  for (const { item, access } of reaches) {
    const where =
      typeof access === "string" || item.where === undefined
        ? [[]]
        : conditionSql(item.where, table, ctx, item.grant.permission.key);
    if (typeof access === "string" || where === undefined) {
      ctx.gaps.push(
        `inherit() of ${key} leaves out ${item.label}: ${typeof access === "string" ? access : "its condition has no Sync Streams form"}`,
      );
      continue;
    }
    for (const clauses of product([access, where])) {
      queries.add(
        `SELECT ${ctx.dialect.column(table, node.id)} FROM ${fromTable(source, ctx.dialect)}${clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`}`,
      );
    }
  }
  return queries.size === 0 && reaches.length > 0 ? undefined : [...queries];
}

/**
 * Whether `permission` keeps a suspended membership: its key is in
 * `rls.suspension.memberships.keep`, so the stream drops the suspension
 * filter.
 */
function keepsSuspended(permission: string | undefined, ctx: Ctx): boolean {
  return (
    permission !== undefined &&
    keptKeys(ctx.config.rls?.suspension?.memberships).includes(permission)
  );
}

/**
 * One `IN (SELECT …)` per role source of the membership table: the row's `left`
 * is an instance the user holds `roles` in. `keep` drops the suspension
 * filter.
 */
function membershipIn(
  table: RlsMembershipTable,
  idColumn: string,
  left: string,
  roles: readonly string[],
  ctx: Ctx,
  keep = false,
): readonly (readonly string[])[] | undefined {
  if (table.expiresAt !== undefined) {
    return undefined;
  }
  const name = bare(table.table, ctx.dialect);
  const sources: readonly RoleSource[] = Array.isArray(table.role)
    ? table.role
    : [table.role];
  const kinds = [...new Set(roles.flatMap((role) => ctx.kinds[role] ?? []))];
  const restricted = roles.some((role) => ctx.kinds[role] !== undefined);
  if (restricted && (table.via === undefined || roles.length !== 1)) {
    return undefined;
  }
  const via = table.via;
  if (restricted && typeof via === "object" && !kinds.includes(via.value)) {
    return [];
  }
  const filters = [
    `${ctx.dialect.column(name, table.user)} = ${ctx.dialect.user}`,
    ...(restricted && typeof via === "string"
      ? [
          `${ctx.dialect.column(name, via)} IN (${kinds.map((kind) => ctx.dialect.literal(kind)).join(", ")})`,
        ]
      : []),
    ...(!keep && table.disabledAt !== undefined
      ? [`${ctx.dialect.column(name, table.disabledAt)} IS NULL`]
      : []),
  ];
  const list = roles.map((role) => ctx.dialect.literal(role)).join(", ");
  return sources.map((source) => {
    if (typeof source === "string") {
      return [
        `${left} IN (SELECT ${ctx.dialect.column(name, idColumn)} FROM ${fromTable(table.table, ctx.dialect)} WHERE ${[...filters, `${ctx.dialect.column(name, source)} IN (${list})`].join(" AND ")})`,
      ];
    }
    if ("map" in source) {
      const values = Object.entries(source.map)
        .filter(([, key]) => key !== null && roles.includes(key))
        .map(([value]) => ctx.dialect.literal(value));
      if (values.length === 0) {
        return ["1 = 0"];
      }
      return [
        `${left} IN (SELECT ${ctx.dialect.column(name, idColumn)} FROM ${fromTable(table.table, ctx.dialect)} WHERE ${[...filters, `${ctx.dialect.column(name, source.column)} IN (${values.join(", ")})`].join(" AND ")})`,
      ];
    }
    const keys = bare(source.through, ctx.dialect);
    return [
      `${left} IN (SELECT ${ctx.dialect.column(name, idColumn)} FROM ${fromTable(table.table, ctx.dialect)} INNER JOIN ${fromTable(source.through, ctx.dialect)} ON ${joinOn(source, keys, name, ctx.dialect)} WHERE ${[...filters, `${ctx.dialect.column(keys, source.column)} IN (${list})`].join(" AND ")})`,
    ];
  });
}

/**
 * The membership filter of scope `scope`: its `rls.memberships` table, else the
 * union of its membership sources.
 */
function membershipSql(
  scope: string,
  left: string,
  roles: readonly string[],
  ctx: Ctx,
  permission?: string,
): readonly (readonly string[])[] | undefined {
  const keep = keepsSuspended(permission, ctx);
  const table = scopeMembershipTable(
    ctx.config.rls?.memberships,
    ctx.scopes,
    scope,
  );
  if (table !== undefined) {
    const idColumn = scopeColumn(table, ctx.scopes, scope);
    return idColumn === undefined
      ? undefined
      : membershipIn(table, idColumn, left, roles, ctx, keep);
  }
  const sources = scopeSourcesOf(ctx.sources, scope);
  if (sources.length === 0) {
    return undefined;
  }
  return sources.flatMap((source) => {
    const stream = streamOf(source);
    if (typeof stream === "string") {
      ctx.gaps.push(stream);
      return [];
    }
    return sourceIn(stream, scope, left, roles, ctx, keep);
  });
}

/**
 * Who the grant reaches, as alternatives of clauses; `undefined` when Sync
 * Streams cannot express it.
 */
export function accessSql(
  item: RlsGrant,
  table: string,
  ctx: Ctx,
): readonly (readonly string[])[] | string {
  const { access } = item;
  switch (access.kind) {
    case "anyone":
    case "authenticated":
      return [[]];
    case "role": {
      if (access.scope === "global") {
        return `global role ${access.role} is not a row filter`;
      }
      const field = ctx.policy.scopes.find(
        (scope) => scope.name === access.scope,
      )?.key;
      if (field === undefined || !SQL_IDENT.test(field)) {
        return `scope ${access.scope} has no row key`;
      }
      return (
        membershipSql(
          access.scope,
          ctx.dialect.column(table, field),
          [access.role],
          ctx,
          item.grant.permission.key,
        ) ??
        `no rls.memberships table without an expiry and with the kinds of ${access.role}, and no membership source, for scope ${access.scope}`
      );
    }
    case "resource": {
      const holder = ctx.config.rls?.memberships?.resource?.[access.resource];
      const node = ctx.policy.resources.get(item.grant.permission.resource);
      const field =
        node?.name === access.resource
          ? node.id
          : node?.parent?.resource === access.resource
            ? node.parent.field
            : undefined;
      if (
        holder === undefined ||
        field === undefined ||
        !SQL_IDENT.test(field)
      ) {
        return `no rls.memberships.resource table for ${access.resource} on the row`;
      }
      return (
        membershipIn(
          holder,
          holder.id ?? "id",
          ctx.dialect.column(table, field),
          [access.role],
          ctx,
          keepsSuspended(item.grant.permission.key, ctx),
        ) ??
        `the ${access.resource} memberships table has an expiry, or lacks via`
      );
    }
    case "actor":
      return "actor grantees are not in the sync token";
    default: {
      const exhaustive: never = access;
      return exhaustive;
    }
  }
}
