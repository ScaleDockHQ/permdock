import type { Scope } from "../core/scopes.ts";
import type { Condition, ConditionValue, Policy } from "../index.ts";
import type { RoleSource } from "../supabase/roles.ts";
import type { RlsGrant } from "./rls-grants.ts";
import type {
  GlobalRoles,
  PermDockConfig,
  RlsMembershipTable,
  RoleThrough,
} from "./types.ts";

import { isConditionDate, isConditionRef } from "../conditions/ast.ts";
import { scopeColumn, scopeMembershipTable } from "../conditions/compile.ts";
import { resolveScope, scopeList } from "../core/scopes.ts";
import { quoteSqlLiteral, SQL_IDENT } from "../core/sql.ts";
import { requiresApproval } from "../index.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import { tableFor } from "./rls-compile.ts";
import { contextRefs } from "./rls-conditions.ts";
import { collectGrants } from "./rls-grants.ts";
import { ownershipRules } from "./rls-ownership.ts";
import { CUSTOM_ROLES } from "./rls-shared.ts";

/**
 * How a stream query names the signed-in user, its claims and row columns.
 * `powersync` writes Sync Streams SQL; `postgres` writes the same query for
 * `permdock powersync verify` to run, with `$1` the user id and `$2` the claims.
 */
export type StreamDialect = {
  readonly user: string;
  claim(name: string): string;
  claims(name: string): string;
  /** A row column; `numeric` keeps its type for a comparison with a number. */
  column(table: string, name: string, numeric?: boolean): string;
  literal(value: string | number | boolean): string;
};

function ident(name: string): string {
  if (!SQL_IDENT.test(name)) {
    throw new TypeError(
      `PermDock CLI: '${name}' is not a plain identifier, which Sync Streams need`,
    );
  }
  return name;
}

export const POWERSYNC: StreamDialect = {
  user: "auth.user_id()",
  claim: (name) => `auth.parameter(${quoteSqlLiteral(name)})`,
  claims: (name) =>
    `(SELECT value FROM json_each(auth.parameter(${quoteSqlLiteral(name)})))`,
  column: (table, name) => `${table}.${ident(name)}`,
  literal: (value) =>
    typeof value === "string" ? quoteSqlLiteral(value) : String(value),
};

export const POSTGRES: StreamDialect = {
  user: "$1::text",
  claim: (name) => `($2::jsonb ->> ${quoteSqlLiteral(name)})`,
  claims: (name) =>
    `(select jsonb_array_elements_text(case jsonb_typeof($2::jsonb -> ${quoteSqlLiteral(name)}) when 'array' then $2::jsonb -> ${quoteSqlLiteral(name)} else '[]'::jsonb end))`,
  column: (table, name, numeric) =>
    `${table}.${ident(name)}${numeric === true ? "" : "::text"}`,
  literal: (value) =>
    typeof value === "number" ? String(value) : quoteSqlLiteral(String(value)),
};

export type PowerSyncStream = {
  readonly name: string;
  readonly resource: string;
  readonly table: string;
  /** The row's id column, which `verify` matches a fixture row on. */
  readonly id: string;
  /** One query per way a subject may read a row; the stream syncs their union. */
  readonly queries: readonly string[];
};

/** A stream of the rows `localSnapshot` builds the user's snapshot from: memberships, roles, custom roles. */
export type SubjectStream = {
  readonly name: string;
  readonly table: string;
  /** The user column when every row is the user's own; `verify` checks no other user's row syncs. */
  readonly user?: string;
  readonly queries: readonly string[];
};

export type PowerSyncPlan = {
  readonly streams: readonly PowerSyncStream[];
  readonly subject: readonly SubjectStream[];
  /** Resources with no stream, and why. */
  readonly omitted: readonly {
    readonly resource: string;
    readonly reason: string;
  }[];
  readonly warnings: readonly string[];
};

/** At most this many queries per stream; a wider `or` product is left out rather than truncated. */
const MAX_QUERIES = 32;

type Ctx = {
  readonly policy: Policy;
  readonly config: PermDockConfig;
  readonly scopes: readonly Scope[];
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  readonly dialect: StreamDialect;
};

/** Every combination of one clause list from each input, ANDed. */
function product(
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

/** The table as a stream query names it: unqualified in `public`, `schema.table` otherwise. */
function bare(table: string): string {
  const name = table.startsWith("public.")
    ? table.slice("public.".length)
    : table;
  return name.split(".").map(ident).join(".");
}

/** A row value: a literal, or a principal ref the token carries. `undefined` when neither. */
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
function conditionSql(
  condition: Condition,
  table: string,
  ctx: Ctx,
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
        condition.conditions.map((child) => conditionSql(child, table, ctx)),
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
      return membershipSql(scope, left, condition.roles, ctx);
    }
    case "not":
    case "contains":
    case "related":
    case "opaque":
    case "sqlFunction":
    case "liveSession":
      return undefined;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/** One `IN (SELECT …)` per role source of the membership table: the row's `left` is an instance the user holds `roles` in. */
function membershipIn(
  table: RlsMembershipTable,
  idColumn: string,
  left: string,
  roles: readonly string[],
  ctx: Ctx,
): readonly (readonly string[])[] | undefined {
  if (table.expiresAt !== undefined || table.disabledAt !== undefined) {
    return undefined;
  }
  const name = bare(table.table);
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
  ];
  const list = roles.map((role) => ctx.dialect.literal(role)).join(", ");
  return sources.map((source) => {
    if (typeof source === "string") {
      return [
        `${left} IN (SELECT ${ctx.dialect.column(name, idColumn)} FROM ${name} WHERE ${[...filters, `${ctx.dialect.column(name, source)} IN (${list})`].join(" AND ")})`,
      ];
    }
    const [pair] = Object.entries(source.on);
    const keys = bare(source.through);
    const [ref, id] = pair ?? ["", ""];
    return [
      `${left} IN (SELECT ${ctx.dialect.column(name, idColumn)} FROM ${name} INNER JOIN ${keys} ON ${ctx.dialect.column(keys, id)} = ${ctx.dialect.column(name, ref)} WHERE ${[...filters, `${ctx.dialect.column(keys, source.column)} IN (${list})`].join(" AND ")})`,
    ];
  });
}

function membershipSql(
  scope: string,
  left: string,
  roles: readonly string[],
  ctx: Ctx,
): readonly (readonly string[])[] | undefined {
  const table = scopeMembershipTable(
    ctx.config.rls?.memberships,
    ctx.scopes,
    scope,
  );
  const idColumn =
    table === undefined ? undefined : scopeColumn(table, ctx.scopes, scope);
  return table === undefined || idColumn === undefined
    ? undefined
    : membershipIn(table, idColumn, left, roles, ctx);
}

/** Who the grant reaches, as alternatives of clauses; `undefined` when Sync Streams cannot express it. */
function accessSql(
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
        ) ??
        `no rls.memberships table without an expiry or disabledAt and with the kinds of ${access.role} for scope ${access.scope}`
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
        ) ??
        `the ${access.resource} memberships table has an expiry or disabledAt, or lacks via`
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

/** `permdock_<table>`, with a schema joined by `_`; a table in the `permdock` schema keeps one prefix. */
function subjectStreamName(table: string): string {
  const name = table.replaceAll(".", "_");
  return name.startsWith("permdock_") ? name : `permdock_${name}`;
}

type SubjectRows = { user: string | undefined; readonly queries: Set<string> };

function roleThroughs(
  role: RlsMembershipTable["role"] | GlobalRoles["role"],
): readonly RoleThrough[] {
  const list = Array.isArray(role) ? role : [role];
  return list.filter(
    (item): item is RoleThrough => typeof item === "object" && item !== null,
  );
}

/**
 * Streams of the rows a device builds the user's snapshot from: the user's
 * own membership and global-role rows, the roles tables they reference, and
 * the custom roles of the user's tenants. Each query starts from the user's
 * own rows.
 */
function subjectStreams(ctx: Ctx): readonly SubjectStream[] {
  const rls = ctx.config.rls;
  const { dialect } = ctx;
  const tables = new Map<string, SubjectRows>();
  const add = (table: string, query: string, user?: string): void => {
    const entry = tables.get(table) ?? {
      user: undefined,
      queries: new Set<string>(),
    };
    if (entry.queries.size === 0) {
      entry.user = user;
    } else if (entry.user !== user) {
      entry.user = undefined;
    }
    entry.queries.add(query);
    tables.set(table, entry);
  };
  const own = (
    table: string,
    user: string,
    role: RlsMembershipTable["role"] | GlobalRoles["role"],
  ): void => {
    const name = bare(table);
    const mine = `${dialect.column(name, user)} = ${dialect.user}`;
    add(name, `SELECT * FROM ${name} WHERE ${mine}`, user);
    for (const through of roleThroughs(role)) {
      const keys = bare(through.through);
      const [pair] = Object.entries(through.on);
      if (pair === undefined) {
        continue;
      }
      const [ref, id] = pair;
      add(
        keys,
        `SELECT * FROM ${keys} WHERE ${dialect.column(keys, id)} IN (SELECT ${dialect.column(name, ref)} FROM ${name} WHERE ${mine})`,
      );
    }
  };
  const memberships = rls?.memberships;
  for (const table of [
    ...Object.values(memberships?.scopes ?? {}),
    ...(memberships?.tenant === undefined ? [] : [memberships.tenant]),
    ...(memberships?.team === undefined ? [] : [memberships.team]),
    ...Object.values(memberships?.resource ?? {}),
  ]) {
    own(table.table, table.user, table.role);
  }
  const schema = rls?.schema ?? PERMDOCK_SCHEMA;
  const database = rls?.authorize === "database";
  const globalRoles =
    rls?.roles ?? (database ? { table: `${schema}.user_roles` } : undefined);
  if (globalRoles !== undefined) {
    own(
      globalRoles.table,
      globalRoles.user ?? "user_id",
      globalRoles.role ?? "role",
    );
  }
  if (database && rls?.customRoles === true) {
    const root = ctx.scopes[0]?.name;
    const tenants =
      root === undefined
        ? undefined
        : scopeMembershipTable(memberships, ctx.scopes, root);
    const column =
      tenants === undefined || root === undefined
        ? undefined
        : scopeColumn(tenants, ctx.scopes, root);
    for (const name of [CUSTOM_ROLES.permissions, CUSTOM_ROLES.includes]) {
      const table = bare(`${schema}.${name}`);
      const tenant = dialect.column(table, "tenant_id");
      add(table, `SELECT * FROM ${table} WHERE ${tenant} IS NULL`);
      if (tenants !== undefined && column !== undefined) {
        const members = bare(tenants.table);
        add(
          table,
          `SELECT * FROM ${table} WHERE ${tenant} IN (SELECT ${dialect.column(members, column)} FROM ${members} WHERE ${dialect.column(members, tenants.user)} = ${dialect.user})`,
        );
      }
    }
  }
  const out: SubjectStream[] = [];
  for (const [table, entry] of tables) {
    const name = subjectStreamName(table);
    const queries = [...entry.queries];
    out.push(
      entry.user === undefined
        ? { name, table, queries }
        : { name, table, user: entry.user, queries },
    );
  }
  return out;
}

/** Why a grant cannot become a stream query, before its conditions are compiled. */
function unsupported(item: RlsGrant): string | undefined {
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

/**
 * Sync Streams for each synced resource: the union of the rows its read
 * permission's allow grants reach. A grant with any part Sync Streams cannot
 * express syncs nothing, and a resource with a deny grant gets no stream, so
 * a stream never holds a row the policy denies.
 */
export function powersyncPlan(
  policy: Policy,
  config: PermDockConfig,
  dialect: StreamDialect = POWERSYNC,
): PowerSyncPlan {
  const scopes = scopeList(policy.scopes);
  const ctx: Ctx = {
    policy,
    config,
    scopes,
    kinds: ownershipRules(policy, scopes)?.kinds ?? {},
    dialect,
  };
  const action = config.powersync?.action ?? "read";
  const grants = collectGrants(policy);
  const resources =
    config.powersync?.resources ??
    [...policy.resources.keys()].filter((name) =>
      grants.some(
        (item) =>
          item.grant.permission.resource === name &&
          item.grant.permission.action === action,
      ),
    );
  const streams: PowerSyncStream[] = [];
  const omitted: { resource: string; reason: string }[] = [];
  const warnings: string[] = [];
  for (const resource of resources) {
    const node = policy.resources.get(resource);
    const key = `${resource}.${action}`;
    const items = grants.filter((item) => item.grant.permission.key === key);
    if (node === undefined || items.length === 0) {
      omitted.push({ resource, reason: `no grant of ${key}` });
      continue;
    }
    if (items.some((item) => item.grant.effect === "deny")) {
      omitted.push({
        resource,
        reason: `${key} has a deny grant, which Sync Streams cannot subtract`,
      });
      continue;
    }
    const table = bare(tableFor(resource, config.rls?.tables));
    const { id } = node;
    const queries = new Set<string>();
    for (const item of items) {
      const label = `${item.label}/${key}`;
      const skipped = unsupported(item);
      const access = skipped ?? accessSql(item, table, ctx);
      if (typeof access === "string") {
        warnings.push(`${label} does not sync: ${access}`);
        continue;
      }
      const where =
        item.where === undefined ? [[]] : conditionSql(item.where, table, ctx);
      if (where === undefined) {
        warnings.push(
          `${label} does not sync: its condition has no Sync Streams form`,
        );
        continue;
      }
      const columns =
        item.grant.fields === undefined
          ? "*"
          : [...new Set([id, ...item.grant.fields])]
              .map((field) => ctx.dialect.column(table, field))
              .join(", ");
      for (const clauses of product([access, where])) {
        queries.add(
          `SELECT ${columns} FROM ${table}${clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`}`,
        );
      }
    }
    if (queries.size === 0) {
      omitted.push({ resource, reason: `no grant of ${key} compiles` });
    } else if (queries.size > MAX_QUERIES) {
      omitted.push({
        resource,
        reason: `${String(queries.size)} queries, over the limit of ${String(MAX_QUERIES)}`,
      });
    } else {
      streams.push({
        name: resource,
        resource,
        table,
        id,
        queries: [...queries],
      });
    }
  }
  return { streams, subject: subjectStreams(ctx), omitted, warnings };
}

/** `sync-config.yaml`: edition 3 Sync Streams, one auto-subscribed stream per synced resource. */
export function powersyncYaml(plan: PowerSyncPlan): string {
  const lines = [
    "# Generated by permdock powersync generate from the policy. Do not edit.",
    "config:",
    "  edition: 3",
    "",
    "streams:",
  ];
  if (plan.streams.length === 0 && plan.subject.length === 0) {
    lines[lines.length - 1] = "streams: {}";
  }
  for (const stream of [...plan.streams, ...plan.subject]) {
    lines.push(
      `  ${stream.name}:`,
      "    auto_subscribe: true",
      "    queries:",
      ...stream.queries.map((query) => `      - ${JSON.stringify(query)}`),
    );
  }
  for (const item of plan.omitted) {
    lines.push(`# ${item.resource}: not synced, ${item.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
