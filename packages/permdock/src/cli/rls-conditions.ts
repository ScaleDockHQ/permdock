import type { RelatedCondition } from "../conditions/ast.ts";
import type { Condition, ConditionValue } from "../index.ts";
import type { RlsSqlContext } from "./rls-sql.ts";
import type { RlsMembershipTable } from "./types.ts";

import { scopeColumn, scopeMembershipTable } from "../conditions/compile.ts";
import { relatedSql } from "../conditions/graph-sql.ts";
import { isReadonlyArray, sole } from "../core/compact.ts";
import { isForbiddenKey } from "../core/paths.ts";
import { resolveScope, rootScope } from "../core/scopes.ts";
import { isSqlFunctionField } from "../index.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import {
  activeInstancesSql,
  activeMembershipSql,
  activeUserSql,
  CLAIM,
  CLOSURE,
  graphHelper,
  graphSqlText,
  inheritedRowsHelper,
  isRecord,
  keyTenantSql,
  kindFilterSql,
  linkHelper,
  liveSessionSql,
  memberIdsHelper,
  memberRoleOf,
  memberVia,
  qualifiedTable,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  restrictedHelper,
  roleKindSql,
  scopeSources,
  scopeTable,
  sqlType,
  subjectClaimJsonSql,
  subjectClaimSql,
  subjectIdSql,
  tenantClaimSql,
} from "./rls-sql.ts";

const MAX_CLAIM_DEPTH = 8;

/**
 * The claim path of a `principal.claim.*` / `principal.claims.*` ref, one
 * segment per JSON key; `undefined` for any other ref.
 */
export function claimPath(ref: string): readonly string[] | undefined {
  const prefix = ["principal.claim.", "principal.claims."].find((item) =>
    ref.startsWith(item),
  );
  if (prefix === undefined) {
    return undefined;
  }
  const segments = ref.slice(prefix.length).split(".");
  if (segments.length > MAX_CLAIM_DEPTH) {
    throw new Error(
      `PermDock CLI: claim path '${ref}' is deeper than ${MAX_CLAIM_DEPTH}`,
    );
  }
  for (const segment of segments) {
    if (!CLAIM.test(segment) || isForbiddenKey(segment)) {
      throw new Error(`PermDock CLI: unsafe claim name '${segment}'`);
    }
  }
  return segments;
}

function jsonPath(
  base: string,
  keys: readonly string[],
  last: "->" | "->>",
): string {
  let sql = base;
  for (const [index, key] of keys.entries()) {
    sql += ` ${index === keys.length - 1 ? last : "->"} ${quoteLiteral(key)}`;
  }
  return sql;
}

/**
 * The JSON document a claim path starts from and the keys to walk in it. The
 * `guc` dialect keeps each top-level claim in its own setting as JSON text.
 */
function claimRoot(
  ctx: RlsSqlContext,
  path: readonly string[],
): { readonly root: string; readonly keys: readonly string[] } {
  const [head, ...rest] = path;
  if (head === undefined) {
    throw new Error("PermDock CLI: empty claim path");
  }
  switch (ctx.dialect) {
    case "supabase":
      return { root: "(select auth.jwt())", keys: path };
    case "neon":
      return { root: "(select auth.session())", keys: path };
    case "guc":
      return { root: subjectClaimJsonSql(ctx, head), keys: rest };
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

/** The claim at `path` as `jsonb`. */
function claimJsonSql(ctx: RlsSqlContext, path: readonly string[]): string {
  const { root, keys } = claimRoot(ctx, path);
  return keys.length === 0 ? root : `(${jsonPath(root, keys, "->")})`;
}

/** The claim at `path` as text: `->>` on the last key, or the plain setting for a one-segment `guc` claim. */
function claimTextSql(ctx: RlsSqlContext, path: readonly string[]): string {
  const [head] = path;
  if (path.length === 1 && head !== undefined) {
    return subjectClaimSql(ctx, head);
  }
  const { root, keys } = claimRoot(ctx, path);
  return `(${jsonPath(root, keys, "->>")})`;
}

/** The JSON kind a claim must have to compare with a column of `type`. */
function jsonKindOf(type: string | undefined): "number" | "boolean" | "string" {
  if (type === "numeric") {
    return "number";
  }
  return type === "boolean" ? "boolean" : "string";
}

/**
 * A claim compared with a column of `type`. Numbers and booleans must be JSON
 * of that kind (anything else is `null`, so the comparison is false, as in
 * memory); other types cast the text form. A one-segment `guc` claim is text
 * and is cast as is.
 */
function typedClaimSql(
  ctx: RlsSqlContext,
  path: readonly string[],
  type: string | undefined,
): string {
  const text = claimTextSql(ctx, path);
  if (type === undefined || type === "text") {
    return text;
  }
  const cast = `${text}::${sqlType(type)}`;
  const kind = jsonKindOf(type);
  if (kind === "string" || (ctx.dialect === "guc" && path.length === 1)) {
    return `(${cast})`;
  }
  return `(case when jsonb_typeof(${claimJsonSql(ctx, path)}) = '${kind}' then ${cast} end)`;
}

/**
 * The elements of an array claim as a Postgres array of the column's type,
 * built once per statement (an uncorrelated `array(select ...)` is an InitPlan).
 * A missing or non-array claim is the empty array; elements of another JSON
 * kind are left out.
 */
function claimArraySql(
  ctx: RlsSqlContext,
  path: readonly string[],
  type: string | undefined,
): string {
  const json = claimJsonSql(ctx, path);
  const element =
    type === undefined || type === "text"
      ? `(e #>> '{}')`
      : `(e #>> '{}')::${sqlType(type)}`;
  return `array(select ${element} from jsonb_array_elements(case when jsonb_typeof(${json}) = 'array' then ${json} else '[]'::jsonb end) e where jsonb_typeof(e) = '${jsonKindOf(type)}')`;
}

function sqlValue(
  value: ConditionValue,
  ctx: RlsSqlContext,
  field?: string,
): string {
  if (value !== null && typeof value === "object" && "ref" in value) {
    return compileRef(value.ref, ctx, field);
  }
  if (value !== null && typeof value === "object" && "date" in value) {
    return quoteLiteral(value.date);
  }
  if (isReadonlyArray(value)) {
    return `array[${value.map((item) => sqlValue(item, ctx)).join(", ")}]`;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "string") {
    return quoteLiteral(value);
  }
  throw new Error("PermDock CLI: non-portable condition value");
}

function compileRef(ref: string, ctx: RlsSqlContext, field?: string): string {
  if (ref === "principal.id") {
    return subjectIdSql(ctx);
  }
  // Only relation periods compile with it; conditions on the wire carry no clock ref.
  if (ref === "now") {
    return "now()";
  }
  const path = claimPath(ref);
  if (
    ref === "principal.tenant" ||
    (path?.length === 1 && path[0] === ctx.tenantClaim)
  ) {
    return tenantClaimSql(ctx);
  }
  if (path !== undefined) {
    return typedClaimSql(
      ctx,
      path,
      field === undefined ? undefined : ctx.columnTypes?.[field],
    );
  }
  if (ref === "context" || ref.startsWith("context.")) {
    throw new Error(
      `PermDock CLI: '${ref}' is request context, which is not in the token; RLS cannot read it (permdock doctor PD027)`,
    );
  }
  throw new Error(`PermDock CLI: non-portable subject ref '${ref}'`);
}

/** `value` with `\`, `%` and `_` escaped for `like ... escape '\'`, as `escapeLike` does in process. */
function likeLiteralSql(value: string): string {
  return `replace(replace(replace(${value}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;
}

function compareSql(
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains",
  field: string,
  value: string,
): string {
  const left = quoteIdent(field);
  switch (op) {
    case "eq":
      return `${left} = ${value}`;
    case "ne":
      return `${left} <> ${value}`;
    case "gt":
      return `${left} > ${value}`;
    case "gte":
      return `${left} >= ${value}`;
    case "lt":
      return `${left} < ${value}`;
    case "lte":
      return `${left} <= ${value}`;
    case "contains":
      return `${left}::text like '%' || ${likeLiteralSql(`${value}::text`)} || '%' escape '\\'`;
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

function existsSql(
  table: RlsMembershipTable,
  rowColumn: string,
  rowField: string,
  roles: readonly string[],
  ctx: RlsSqlContext,
  tenantColumn?: string,
  scope?: string,
): string {
  const parts = [
    `m.${quoteIdent(rowColumn)} = ${quoteIdent(rowField)}`,
    `m.${quoteIdent(table.user)} = ${subjectIdSql(ctx)}`,
  ];
  const role = memberRoleOf(table);
  if (roles.length > 0) {
    const roleList = roles.map((name) => name.replaceAll("'", "''")).join(",");
    const held =
      role.through === undefined && !role.lateral
        ? `m.${quoteIdent(role.column)}`
        : role.lookup;
    parts.push(`${held} = any('{${roleList}}')`);
    const via = memberVia(table);
    const single = sole(roles);
    const kind =
      single === undefined
        ? kindFilterSql(ctx, role.lookup, via)
        : roleKindSql(ctx, single, via);
    if (kind !== undefined) {
      parts.push(kind);
    }
  }
  if (table.expiresAt !== undefined) {
    parts.push(
      `(m.${quoteIdent(table.expiresAt)} is null or m.${quoteIdent(table.expiresAt)} > now())`,
    );
  }
  parts.push(
    ...activeMembershipSql(
      ctx,
      table.disabledAt === undefined
        ? undefined
        : `m.${quoteIdent(table.disabledAt)}`,
    ),
  );
  if (tenantColumn !== undefined && ctx.tenants !== "all") {
    parts.push(`m.${quoteIdent(tenantColumn)} = ${tenantClaimSql(ctx)}`);
  }
  parts.push(...activeUserSql(ctx));
  if (scope !== undefined) {
    const tenantOf = scope === rootScope(ctx.scopes) ? rowColumn : tenantColumn;
    const keyed = keyTenantSql(
      ctx,
      tenantOf === undefined ? undefined : `m.${quoteIdent(tenantOf)}`,
    );
    if (keyed !== undefined) {
      parts.push(keyed);
    }
    parts.push(
      ...activeInstancesSql(ctx, scope, (name) => {
        const held = scopeColumn(table, ctx.scopes, name);
        return held === undefined ? undefined : `m.${quoteIdent(held)}`;
      }),
    );
  }
  const expand = roles.length > 0 && role.lateral ? role.join : "";
  return `exists (select 1 from ${quoteTable(table.table)} m${expand} where ${parts.join(" and ")})`;
}

function compileMemberOf(
  condition: Extract<Condition, { readonly op: "memberOf" }>,
  ctx: RlsSqlContext,
): string {
  const scope =
    condition.scope === "resource"
      ? undefined
      : resolveScope(ctx.scopes, condition.scope);
  if (condition.scope !== "resource" && scope === undefined) {
    throw new Error(
      `PermDock CLI: memberOf ${condition.scope} names a scope the policy does not declare`,
    );
  }
  const mapping =
    scope === undefined
      ? condition.resource === undefined
        ? undefined
        : ctx.memberships?.resource?.[condition.resource]
      : scopeMembershipTable(ctx.memberships, ctx.scopes, scope);
  if (mapping !== undefined) {
    const named = scope === undefined ? undefined : scopeTable(ctx, scope);
    const rowColumn = scope === undefined ? mapping.id : named?.column;
    if (rowColumn === undefined) {
      throw new Error(
        `PermDock CLI: memberships mapping for ${condition.scope} is missing the row column`,
      );
    }
    const tenantColumn =
      scope === undefined || scope === rootScope(ctx.scopes)
        ? undefined
        : named?.tenantColumn;
    const primary = existsSql(
      mapping,
      rowColumn,
      condition.field,
      condition.roles,
      ctx,
      tenantColumn,
      scope,
    );
    if (condition.scope !== "resource" || condition.parents === undefined) {
      return primary;
    }
    const extras = condition.parents.flatMap((parent) => {
      if (typeof parent === "string") {
        return [
          existsSql(
            mapping,
            rowColumn,
            parent,
            condition.roles,
            ctx,
            tenantColumn,
          ),
        ];
      }
      const hopTable = ctx.memberships?.resource?.[parent.resource];
      return hopTable?.id === undefined
        ? []
        : [
            existsSql(
              hopTable,
              hopTable.id,
              parent.field,
              condition.roles,
              ctx,
            ),
          ];
    });
    return `(${[primary, ...extras].join(" or ")})`;
  }
  if (
    scope !== undefined &&
    condition.roles.length === 0 &&
    scopeSources(ctx, scope).length > 0
  ) {
    return `${quoteIdent(condition.field)} in (select ${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${memberIdsHelper(scope)}())`;
  }
  if (scope !== undefined && scope === rootScope(ctx.scopes)) {
    const parts = [
      ctx.tenants === "all"
        ? `${quoteIdent(condition.field)} in (select ${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${memberIdsHelper(scope)}())`
        : `${quoteIdent(condition.field)} = ${tenantClaimSql(ctx)}`,
      ...(ctx.tenants === "all"
        ? []
        : [keyTenantSql(ctx, quoteIdent(condition.field))].filter(
            (part) => part !== undefined,
          )),
      ...activeUserSql(ctx),
      ...activeInstancesSql(ctx, scope, () => quoteIdent(condition.field)),
    ];
    return parts.length === 1 ? parts.join("") : `(${parts.join(" and ")})`;
  }
  throw new Error(
    `PermDock CLI: memberOf ${condition.scope} needs a memberships table mapping`,
  );
}

export function compileConditionSql(
  condition: Condition,
  ctx: RlsSqlContext,
): string {
  switch (condition.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareSql(
        condition.op,
        condition.field,
        sqlValue(condition.value, ctx, condition.field),
      );
    case "contains": {
      const element = ctx.arrayColumns?.[condition.field];
      if (element !== undefined) {
        const value = sqlValue(
          condition.value,
          {
            ...ctx,
            columnTypes: { ...ctx.columnTypes, [condition.field]: element },
          },
          condition.field,
        );
        return `${value} = any(${quoteIdent(condition.field)})`;
      }
      return compareSql(
        condition.op,
        condition.field,
        sqlValue(condition.value, ctx, condition.field),
      );
    }
    case "in":
    case "notIn": {
      const keyword = condition.op === "in" ? "in" : "not in";
      if (
        !Array.isArray(condition.value) &&
        typeof condition.value === "object" &&
        "ref" in condition.value
      ) {
        const path = claimPath(condition.value.ref);
        if (path === undefined) {
          compileRef(condition.value.ref, ctx);
          throw new Error(
            `PermDock CLI: non-portable ${condition.op} against '${condition.value.ref}'`,
          );
        }
        const column = quoteIdent(condition.field);
        const list = claimArraySql(
          ctx,
          path,
          ctx.columnTypes?.[condition.field],
        );
        return condition.op === "in"
          ? `${column} = any (${list})`
          : `(${column} is not null and not (${column} = any (${list})))`;
      }
      // SAFETY: an in / notIn value is a list or a ref, and the ref case returned above.
      const values = (condition.value as readonly ConditionValue[]).map(
        (item) => sqlValue(item, ctx),
      );
      return `${quoteIdent(condition.field)} ${keyword} (${values.join(", ")})`;
    }
    case "isNull":
      return `${quoteIdent(condition.field)} is ${condition.value ? "" : "not "}null`;
    case "and":
      return `(${condition.conditions.map((item) => compileConditionSql(item, ctx)).join(" and ")})`;
    case "or":
      if (condition.conditions.length === 0) {
        return "false";
      }
      return `(${condition.conditions.map((item) => compileConditionSql(item, ctx)).join(" or ")})`;
    case "not":
      return `(${compileConditionSql(condition.condition, ctx)}) is not true`;
    case "memberOf":
      return compileMemberOf(condition, ctx);
    case "related":
      return compileRelatedSql(condition, ctx);
    case "sqlFunction":
      if (ctx.inlineFunctions === true) {
        return compileConditionSql(condition.twin, ctx);
      }
      return `${quoteTable(condition.name)}(${condition.args
        .map((arg) =>
          isSqlFunctionField(arg) ? quoteIdent(arg.field) : sqlValue(arg, ctx),
        )
        .join(", ")})`;
    case "opaque":
      return condition.sql;
    case "liveSession":
      return liveSessionSql(ctx);
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

export function andConditions(
  left: Condition | undefined,
  right: Condition | undefined,
): Condition | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return { op: "and", conditions: [left, right] };
}

function valueContextRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(valueContextRefs);
  }
  if (
    isRecord(value) &&
    typeof value["ref"] === "string" &&
    (value["ref"] === "context" || value["ref"].startsWith("context."))
  ) {
    return [value["ref"]];
  }
  return [];
}

/**
 * The `context.*` refs a condition reads. The request context is not in the
 * token, so RLS cannot evaluate them.
 */
export function contextRefs(
  condition: Condition | undefined,
): readonly string[] {
  if (condition === undefined) {
    return [];
  }
  switch (condition.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains":
    case "in":
    case "notIn":
      return valueContextRefs(condition.value);
    case "and":
    case "or":
      return condition.conditions.flatMap((child) => contextRefs(child));
    case "not":
      return contextRefs(condition.condition);
    case "sqlFunction":
      return [
        ...condition.args.flatMap(valueContextRefs),
        ...contextRefs(condition.twin),
      ];
    case "isNull":
    case "memberOf":
    case "related":
    case "opaque":
    case "liveSession":
      return [];
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

export function sqlFunctionNames(
  condition: Condition | undefined,
): readonly string[] {
  if (condition === undefined) {
    return [];
  }
  switch (condition.op) {
    case "sqlFunction":
      return [condition.name, ...sqlFunctionNames(condition.twin)];
    case "and":
    case "or":
      return condition.conditions.flatMap((child) => sqlFunctionNames(child));
    case "not":
      return sqlFunctionNames(condition.condition);
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains":
    case "in":
    case "notIn":
    case "isNull":
    case "memberOf":
    case "related":
    case "opaque":
    case "liveSession":
      return [];
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/**
 * A `related` condition as uncorrelated subqueries, so Postgres runs the
 * helper once per statement: the row's field in the closure's descendants of
 * the ids the subject holds the relation on (or those ids alone at depth 0).
 * The helper sits in `array(...)` so it stays an InitPlan; a plain `in` gets
 * pulled into a join that can rescan it per closure row.
 */
function compileRelatedSql(
  condition: RelatedCondition,
  ctx: RlsSqlContext,
): string {
  if (condition.hops !== undefined && condition.hops.length > 0) {
    return compileHoppedSql(condition, ctx);
  }
  const type = ctx.columnTypes?.[condition.field];
  const cast = type === undefined || type === "text" ? "" : `::${type}`;
  const column =
    type === undefined
      ? `${quoteIdent(condition.field)}::text`
      : quoteIdent(condition.field);
  const helper =
    condition.permission === undefined
      ? `${`${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${graphHelper(condition.resource)}`}(${quoteLiteral(condition.relation)})`
      : `${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${inheritedRowsHelper(condition.resource)}(${quoteLiteral(condition.permission)})`;
  const cap = ctx.graph?.closures[condition.resource];
  let inner: string;
  if (condition.depth > 0 && cap !== undefined) {
    const depth =
      condition.depth < cap ? ` and depth <= ${String(condition.depth)}` : "";
    inner = `select descendant${cast} from ${`${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${CLOSURE.table}`} where resource = ${quoteLiteral(condition.resource)}${depth} and ancestor = any (array(select ${helper}))`;
  } else {
    inner =
      cast === ""
        ? `select ${helper}`
        : `select p.id${cast} from ${helper} as p(id)`;
  }
  const reach = `${column} in (${inner})`;
  if (condition.parent === true && condition.restricted !== undefined) {
    return `(${reach} and ${quoteIdent(condition.restricted)} is not true)`;
  }
  return reach;
}

/**
 * A `related` condition that crosses link hops: the reached instances of the
 * last resource, carried back over each link by its security definer helper,
 * so the hop reads a table the subject may not see.
 */
function compileHoppedSql(
  condition: RelatedCondition,
  ctx: RlsSqlContext,
): string {
  const resources = ctx.graph?.resources;
  if (resources === undefined) {
    throw new Error(
      "PermDock CLI: a related condition with link hops needs the policy resources in the RLS context",
    );
  }
  const schema = quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA);
  return graphSqlText(
    relatedSql(condition, {
      resources,
      ...(ctx.graph?.tables === undefined ? {} : { tables: ctx.graph.tables }),
      closure: `${ctx.schema ?? PERMDOCK_SCHEMA}.${CLOSURE.table}`,
      closureDepths: ctx.graph?.closures ?? {},
      qualify: qualifiedTable,
      holders: (resource, relation) => [
        {
          text: `select ${schema}.${graphHelper(resource)}(${quoteLiteral(relation)})`,
        },
      ],
      permitted: (resource, permission) => [
        {
          text: `select ${schema}.${inheritedRowsHelper(resource)}(${quoteLiteral(permission)})`,
        },
      ],
      restrictedRows: (resource) => [
        { text: `select ${schema}.${restrictedHelper(resource)}()` },
      ],
      linked: (resource, link, targets) => [
        {
          text: `select ${schema}.${linkHelper(resource, link)}(array(`,
        },
        ...targets,
        { text: "))" },
      ],
    }),
    ctx,
  );
}
