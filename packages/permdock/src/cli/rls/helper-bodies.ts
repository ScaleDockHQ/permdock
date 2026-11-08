import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { CheckedPermission, RlsSqlContext } from "../sql/context.ts";
import type { RlsMembershipTable } from "../types.ts";

import { scopeColumn } from "../../conditions/compile.ts";
import { sqlTextArray } from "../../core/sql.ts";
import {
  activeInstanceChecks,
  activeMembershipSql,
  activeUserChecks,
  disabledKeep,
  grantPermissionSql,
  keptRowSql,
} from "../sql/active.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import { memberRoleOf, scopeSources, scopeTable } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { CUSTOM_ROLES, HELPERS, rootName, signedIn } from "../sql/shared.ts";
import {
  globalKindFilterSql,
  keyTenantSql,
  kindFilterSql,
  memberVia,
  subjectClaimJsonSql,
  subjectIdSql,
} from "../sql/subject.ts";
import { customKeysArrayQuery, customKeysQuery } from "./custom-roles.ts";
import {
  activeTenant,
  andLine,
  customKeysJoin,
  globalRoleRows,
  instancesActive,
  keyTenantLine,
  membershipRows,
  narrowsTo,
  roleRows,
  userActive,
} from "./helper-rows.ts";

/** The call that answers the grant keys a declared role holds on a scope. */
function roleKeys(ctx: RlsSqlContext, scope: string, role: string): string {
  return `${qualified(ctx, "permdock_role_keys")}(${quoteLiteral(scope)}, ${role})`;
}

/**
 * How a body reaches the grant keys of a declared role: a lateral call of
 * `permdock_role_grants(scope, role)`, the one inlinable function over
 * `role_permissions`, or with `rls.seeds: 'view'` the jsonb map
 * `permdock_role_keys(scope, role)`, which a hash lookup answers where the
 * view's `values` list is scanned.
 */
function rpJoin(
  ctx: RlsSqlContext,
  scope: string,
  role: string,
  set: boolean,
  indent: string,
): string {
  if (ctx.seeds !== "view") {
    return `${indent}cross join lateral ${qualified(ctx, HELPERS.roleGrantKeys)}(${quoteLiteral(scope)}, ${role}) rp(grant_key)\n`;
  }
  return set
    ? `${indent}cross join lateral jsonb_array_elements_text(coalesce(${roleKeys(ctx, scope, role)}, '[]'::jsonb)) rp(grant_key)\n`
    : "";
}

function rpConds(
  ctx: RlsSqlContext,
  scope: string,
  role: string,
  set: boolean,
): readonly string[] {
  if (ctx.seeds !== "view") {
    return set ? [] : ["rp.grant_key = p_grant"];
  }
  return set ? [] : [`jsonb_exists(${roleKeys(ctx, scope, role)}, p_grant)`];
}

function rpWhere(
  ctx: RlsSqlContext,
  scope: string,
  role: string,
  set: boolean,
  indent: string,
): string {
  return rpConds(ctx, scope, role, set)
    .map((cond) => `\n${indent}and ${cond}`)
    .join("");
}

function hasSetBody(ctx: RlsSqlContext): string {
  const active = userActive(ctx, "    ")
    .map((line) => `\n${line}`)
    .join("");
  const custom = ctx.customRoles;
  if (ctx.authorize === "database") {
    const ur = globalRoleRows(ctx);
    const declared = `  select rp.grant_key
  from ${ur.from}
${rpJoin(ctx, "global", ur.roleSql, true, "  ")}  where ${ur.userSql} = ${subjectIdSql(ctx)}${rpWhere(ctx, "global", ur.roleSql, true, "    ")}${andLine("    ", globalKindFilterSql(ctx, ur.roleSql))}${active}`;
    if (custom === undefined) {
      return declared;
    }
    const keys = customKeysQuery(ctx, {
      scope: "global",
      role: ur.roleSql,
      tenant: undefined,
      instance: undefined,
    });
    return `${declared}
  union
  select ck.grant_key
  from ${ur.from}
  cross join lateral (${keys}) ck(grant_key)
  where ${ur.userSql} = ${subjectIdSql(ctx)}
    and not (${ur.roleSql} = any(${sqlTextArray(custom.declared)}))${active}`;
  }
  const declared = `  select rp.grant_key
  from ${roleRows(ctx)}
${rpJoin(ctx, "global", "r.role", true, "  ")}  where ${signedIn(ctx)}${rpWhere(ctx, "global", "r.role", true, "    ")}${andLine("    ", globalKindFilterSql(ctx, "r.role"))}${active}`;
  if (custom === undefined) {
    return declared;
  }
  const claim = subjectClaimJsonSql(ctx, GLOBAL_GRANTS_CLAIM);
  return `${declared}
  union
  select ck.grant_key
  from ${roleRows(ctx)}
  cross join lateral (select ${claim} -> r.role as g) cg
${customKeysJoin(
  ctx,
  "global",
  claimEntries("left(e, 1) not in ('-', '@')", "e"),
  claimEntries("left(e, 1) = '-'", "substr(e, 2)"),
  claimEntries("left(e, 1) = '@'", "substr(e, 2)"),
)}
  where ${signedIn(ctx)}
    and jsonb_typeof(cg.g) = 'array'
    and not (r.role = any(${sqlTextArray(custom.declared)}))${active}`;
}

export function hasBody(ctx: RlsSqlContext): string {
  if (ctx.grantSet === true) {
    return hasSetBody(ctx);
  }
  const active = userActive(ctx, "      ")
    .map((line) => `\n${line}`)
    .join("");
  const custom = ctx.customRoles;
  if (ctx.authorize === "database") {
    const ur = globalRoleRows(ctx);
    const declared = `  select exists (
    select 1
    from ${ur.from}
${rpJoin(ctx, "global", ur.roleSql, false, "    ")}    where ${ur.userSql} = ${subjectIdSql(ctx)}${rpWhere(ctx, "global", ur.roleSql, false, "      ")}${andLine("      ", globalKindFilterSql(ctx, ur.roleSql))}${active}
  )`;
    if (custom === undefined) {
      return declared;
    }
    // A platform custom role: rows with no tenant at scope global, held through the global roles table.
    const keys = customKeysQuery(ctx, {
      scope: "global",
      role: ur.roleSql,
      tenant: undefined,
      instance: undefined,
    });
    return `${declared}
  or exists (
    select 1
    from ${ur.from}
    where ${ur.userSql} = ${subjectIdSql(ctx)}
      and not (${ur.roleSql} = any(${sqlTextArray(custom.declared)}))${active}
      and p_grant in (${keys})
  )`;
  }
  const declared = `  select ${signedIn(ctx)} and exists (
    select 1
    from ${roleRows(ctx)}
${rpJoin(ctx, "global", "r.role", false, "    ")}    where ${rpConds(ctx, "global", "r.role", false).join("\n      and ")}${andLine("      ", globalKindFilterSql(ctx, "r.role"))}${active}
  )`;
  if (custom === undefined) {
    return declared;
  }
  // A platform custom role's entries ride the top-level role_grants claim, keyed by role name.
  const claim = subjectClaimJsonSql(ctx, GLOBAL_GRANTS_CLAIM);
  return `${declared}
  or (${signedIn(ctx)} and exists (
    select 1
    from ${roleRows(ctx)}
    cross join lateral (select ${claim} -> r.role as g) cg
    where jsonb_typeof(cg.g) = 'array'
      and not (r.role = any(${sqlTextArray(custom.declared)}))${active}
      ${customKeysSql(
        ctx,
        "global",
        claimEntries("left(e, 1) not in ('-', '@')", "e"),
        claimEntries("left(e, 1) = '-'", "substr(e, 2)"),
        claimEntries("left(e, 1) = '@'", "substr(e, 2)"),
      ).trimStart()}
  ))`;
}

/**
 * The claim `jwt` mode reads platform custom roles from:
 * `customRoleClaim(globalRoles)`.
 */
const GLOBAL_GRANTS_CLAIM = "role_grants";

export function memberColumn(name: string): string {
  return `m.${quoteIdent(name)}`;
}

export function disabledColumn(table: {
  readonly disabledAt?: string;
}): string | undefined {
  return table.disabledAt === undefined
    ? undefined
    : memberColumn(table.disabledAt);
}

export function claimKeptLines(
  ctx: RlsSqlContext,
  indent: string,
  permission?: CheckedPermission,
): string[] {
  return disabledKeep(ctx).length === 0
    ? []
    : [`${indent}and ${keptRowSql("m -> 'keep'", permission)}`];
}

/** Entries of a compact custom-role claim (`cg.g`) that match `where`. */
function claimEntries(where: string, value: string): string {
  return `array(select ${value} from jsonb_array_elements_text(cg.g) e where ${where})`;
}

/** `p_grant in (select permdock_custom_keys(allows, denies, includes, scope))`. */
function customKeysSql(
  ctx: RlsSqlContext,
  scope: string,
  allows: string,
  denies: string,
  includes: string,
): string {
  return `    and p_grant in (select ${qualified(ctx, CUSTOM_ROLES.keys)}(
      ${allows},
      ${denies},
      ${includes},
      ${quoteLiteral(scope)}
    ))`;
}

type TableFilters = {
  readonly owner: string;
  readonly joins: readonly string[];
  readonly filters: readonly string[];
};

function tableFilters(
  ctx: RlsSqlContext,
  scope: string,
  table: RlsMembershipTable,
  tenantColumn: string | undefined,
  grant: string,
): TableFilters {
  const filters: string[] = [];
  if (table.expiresAt !== undefined) {
    const expires = memberColumn(table.expiresAt);
    filters.push(`    and (${expires} is null or ${expires} > now())`);
  }
  filters.push(
    ...activeMembershipSql(
      ctx,
      disabledColumn(table),
      grantPermissionSql(grant),
    ).map((part) => `    and ${part}`),
  );
  if (tenantColumn !== undefined && ctx.tenants !== "all") {
    filters.push(
      `    and (${activeTenant(ctx)} is null or ${memberColumn(tenantColumn)}::text = ${activeTenant(ctx)})`,
    );
  }
  const keyed = keyTenantSql(
    ctx,
    tenantColumn === undefined ? undefined : memberColumn(tenantColumn),
  );
  if (keyed !== undefined) {
    filters.push(`    and ${keyed}`);
  }
  const user = activeUserChecks(
    ctx,
    memberColumn(table.user),
    "act_user",
    "  ",
  );
  const instances = activeInstanceChecks(
    ctx,
    scope,
    (name) => {
      const held = scopeColumn(table, ctx.scopes, name);
      return held === undefined ? undefined : memberColumn(held);
    },
    (name) => `act_${name}`,
    "  ",
    grantPermissionSql(grant),
  );
  filters.push(...instances.filters.map((part) => `    and ${part}`));
  return {
    owner: `  where ${memberColumn(table.user)} = ${subjectIdSql(ctx)}`,
    joins: [...user.joins, ...instances.joins],
    filters,
  };
}

function tableBranch(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
  table: RlsMembershipTable,
  column: string,
  tenantColumn: string | undefined,
  branch: "declared" | "custom",
  set: boolean,
  declared: readonly string[],
  stale?: boolean,
): string {
  const grant =
    branch === "custom" && set
      ? "ck.grant_key"
      : set
        ? "rp.grant_key"
        : "p_grant";
  const checks = tableFilters(ctx, scope, table, tenantColumn, grant);
  const role = memberRoleOf(table, "m", "  ");
  const kind = kindFilterSql(ctx, role.sql, memberVia(table));
  const gate =
    stale === true
      ? [`    and not (select ${qualified(ctx, HELPERS.tokenCurrent)}())`]
      : [];
  const custom = ctx.customRoles;
  // A custom role asked by one grant key probes its entries once per membership
  // into `pdk_m`; the keys of each distinct set of entries are read once.
  const shared = branch === "custom" && !set && custom !== undefined;
  const lines = [
    branch === "declared"
      ? `  select${role.lateral ? " distinct" : ""} ${memberColumn(column)}::${type}${set ? ", rp.grant_key" : ""}`
      : shared
        ? `  select ${memberColumn(column)}::${type} as id, pdk_e.keys`
        : `  select ${memberColumn(column)}::${type}, ck.grant_key`,
    `  from ${quoteQualified(table.table)} m${role.join}`,
    ...checks.joins,
    ...(shared
      ? [
          `  cross join lateral (${customKeysArrayQuery(ctx, probeOf(ctx, scope, column, tenantColumn, role.sql))}) pdk_e`,
        ]
      : []),
    ...(branch === "custom" && set && custom !== undefined
      ? [
          `  cross join lateral (${customKeysQuery(ctx, probeOf(ctx, scope, column, tenantColumn, role.sql))}) ck(grant_key)`,
        ]
      : []),
    ...(branch === "declared"
      ? rpJoin(ctx, scope, role.sql, set, "  ")
          .split("\n")
          .filter((line) => line !== "")
      : []),
    checks.owner,
    ...gate,
    ...(branch === "declared"
      ? [
          ...rpConds(ctx, scope, role.sql, set).map(
            (cond) => `    and ${cond}`,
          ),
          ...(kind === undefined ? [] : [`    and ${kind}`]),
        ]
      : [`    and not (${role.sql} = any(${sqlTextArray(declared)}))`]),
    ...checks.filters,
  ];
  return lines.join("\n");
}

function probeOf(
  ctx: RlsSqlContext,
  scope: string,
  column: string,
  tenantColumn: string | undefined,
  roleSql: string,
) {
  return {
    scope,
    role: roleSql,
    tenant: `(${memberColumn(tenantColumn ?? column)})::${tenantTypeOf(ctx)}`,
    instance: `${memberColumn(column)}::text`,
  };
}

function tableBody(ctx: RlsSqlContext, scope: string, type: string): string {
  const mapped = scopeTable(ctx, scope);
  if (mapped === undefined) {
    return `  select null::${type}${ctx.grantSet === true ? ", null::text" : ""} where false -- no ${scope} memberships table configured`;
  }
  const { table, column, tenantColumn } = mapped;
  const set = ctx.grantSet === true;
  const custom = ctx.customRoles;
  const branches: string[] = [];
  if (ctx.claimsFirst === true && !set) {
    branches.push(claimDeclaredBody(ctx, scope, type));
    branches.push(
      tableBranch(
        ctx,
        scope,
        type,
        table,
        column,
        tenantColumn,
        "declared",
        set,
        [],
        true,
      ),
    );
  } else {
    branches.push(
      tableBranch(
        ctx,
        scope,
        type,
        table,
        column,
        tenantColumn,
        "declared",
        set,
        [],
      ),
    );
  }
  if (custom === undefined) {
    return branches.join("\n  union\n");
  }
  const held = tableBranch(
    ctx,
    scope,
    type,
    table,
    column,
    tenantColumn,
    "custom",
    set,
    custom.declared,
  );
  if (set) {
    return [...branches, held].join("\n  union\n");
  }
  return withCustomKeys(held, branches, "p_grant");
}

/**
 * The branches of a body asked by one grant key, with the custom roles' branch
 * over `pdk_m`: one row per membership with the compiled keys of its role.
 */
function withCustomKeys(
  members: string,
  declared: readonly string[],
  grant: string,
): string {
  const held = `  select pdk_m.id from pdk_m
  where ${grant} = any(pdk_m.keys)`;
  return `  with pdk_m as (
${members}
  )
${[...declared, held].join("\n  union\n")}`;
}

/** The membership's instance of the first scope, from the canonical claim. */
export function claimTenant(ctx: RlsSqlContext, scope: string): string {
  const root = rootName(ctx);
  return scope === root
    ? `m ->> 'id'`
    : `m -> 'within' ->> ${quoteLiteral(root)}`;
}

function claimDeclaredBody(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
): string {
  const grant = "p_grant";
  const narrow = narrowsTo(ctx, scope)
    ? `\n    and (${activeTenant(ctx)} is null or ${claimTenant(ctx, scope)} = ${activeTenant(ctx)})`
    : "";
  const user = activeUserChecks(ctx, subjectIdSql(ctx), "act_user", "  ");
  const instances = activeInstanceChecks(
    ctx,
    scope,
    (name) =>
      name === scope ? `m ->> 'id'` : `m -> 'within' ->> ${quoteLiteral(name)}`,
    (name) => `act_${name}`,
    "  ",
    grantPermissionSql(grant),
  );
  const filters = [
    `    and (select ${qualified(ctx, HELPERS.tokenCurrent)}())`,
    `    and m ->> 'scope' = ${quoteLiteral(scope)}`,
    `    and m ->> 'id' is not null${narrow}${keyTenantLine(ctx, scope, claimTenant(ctx, scope))}`,
    `    and case jsonb_typeof(m -> 'expires_at')
      when 'number' then (m ->> 'expires_at')::numeric > extract(epoch from now())
      else true
    end`,
    ...claimKeptLines(ctx, "    ", grantPermissionSql(grant)),
    ...instances.filters.map((part) => `    and ${part}`),
  ];
  const kind = kindFilterSql(ctx, "r.role", "m ->> 'via'");
  return [
    `  select (m ->> 'id')::${type}`,
    `  from ${membershipRows(ctx)}`,
    ...user.joins,
    ...instances.joins,
    ...rpJoin(ctx, scope, "r.role", false, "  ")
      .split("\n")
      .filter((line) => line !== ""),
    `  where ${signedIn(ctx)}`,
    ...rpConds(ctx, scope, "r.role", false).map((cond) => `    and ${cond}`),
    ...(kind === undefined ? [] : [`    and ${kind}`]),
    ...filters,
  ].join("\n");
}

function claimBody(ctx: RlsSqlContext, scope: string, type: string): string {
  const set = ctx.grantSet === true;
  const narrow = narrowsTo(ctx, scope)
    ? `
    and (${activeTenant(ctx)} is null or ${claimTenant(ctx, scope)} = ${activeTenant(ctx)})`
    : "";
  const filtersFor = (
    grant: string,
  ): string => `    and m ->> 'scope' = ${quoteLiteral(scope)}
    and m ->> 'id' is not null${narrow}${keyTenantLine(ctx, scope, claimTenant(ctx, scope))}
    and case jsonb_typeof(m -> 'expires_at')
      when 'number' then (m ->> 'expires_at')::numeric > extract(epoch from now())
      else true
    end${[
      ...claimKeptLines(ctx, "    ", grantPermissionSql(grant)),
      ...userActive(ctx, "    "),
      ...instancesActive(
        ctx,
        scope,
        (name) =>
          name === scope
            ? `m ->> 'id'`
            : `m -> 'within' ->> ${quoteLiteral(name)}`,
        "    ",
        grantPermissionSql(grant),
      ),
    ]
      .map((line) => `\n${line}`)
      .join("")}`;
  const filters = filtersFor(set ? "rp.grant_key" : "p_grant");
  const declared = `  select (m ->> 'id')::${type}${set ? ", rp.grant_key" : ""}
  from ${membershipRows(ctx)}
${rpJoin(ctx, scope, "r.role", set, "  ")}  where ${signedIn(ctx)}${rpWhere(ctx, scope, "r.role", set, "    ")}${andLine("    ", kindFilterSql(ctx, "r.role", "m ->> 'via'"))}
${filters}`;
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return declared;
  }
  if (set) {
    return `${declared}
  union
  select (m ->> 'id')::${type}, ck.grant_key
  from ${membershipRows(ctx)}
  cross join lateral (select m -> 'grants' -> r.role as g) cg
${customKeysJoin(
  ctx,
  scope,
  claimEntries("left(e, 1) not in ('-', '@')", "e"),
  claimEntries("left(e, 1) = '-'", "substr(e, 2)"),
  claimEntries("left(e, 1) = '@'", "substr(e, 2)"),
)}
  where ${signedIn(ctx)}
    and jsonb_typeof(cg.g) = 'array'
    and not (r.role = any(${sqlTextArray(custom.declared)}))
${filtersFor("ck.grant_key")}`;
  }
  // A custom role rides the membership of the scope it is held at.
  return `${declared}
  union
  select (m ->> 'id')::${type}
  from ${membershipRows(ctx)}
  cross join lateral (select m -> 'grants' -> r.role as g) cg
  where ${signedIn(ctx)}
    and jsonb_typeof(cg.g) = 'array'
    and not (r.role = any(${sqlTextArray(custom.declared)}))
${filters}
${customKeysSql(
  ctx,
  scope,
  claimEntries("left(e, 1) not in ('-', '@')", "e"),
  claimEntries("left(e, 1) = '-'", "substr(e, 2)"),
  claimEntries("left(e, 1) = '@'", "substr(e, 2)"),
)}`;
}

/**
 * The rows the membership sources select for the subject, one per instance
 * (`scope`, `id`, `within`, `roles`, `via`), with each source's own expiry and
 * suspension filters: the statements the token hook runs.
 */
export function sourcesKeep(sources: readonly SqlMembershipSource[]): boolean {
  return sources.some((source) => source.sql.keeps);
}

export function sourceRows(sources: readonly SqlMembershipSource[]): string {
  const keep = sourcesKeep(sources);
  return sources
    .map((source, index) =>
      source.sql.select(sourceUser(index), keep).replaceAll(/^/gmu, "    "),
    )
    .join("\n    union all\n");
}

function sourceUser(index: number): string {
  return `v_user_${String(index)}`;
}

/**
 * A helper body, and the PL/pgSQL variables it reads: one per membership
 * source, holding `user` as that source's user column type so each `select`
 * compares the column uncast and its index applies.
 */
export type Body = {
  readonly sql: string;
  readonly vars: readonly string[];
  readonly memo?: {
    readonly type: string;
    readonly scope: string;
    readonly user: string;
    readonly api?: "better-supabase";
  };
};

export function memoizes(ctx: RlsSqlContext): boolean {
  return (
    ctx.noMemo !== true &&
    ctx.authorize === "database" &&
    ctx.dialect === "supabase" &&
    ctx.grantSet !== true &&
    ctx.subjectId === undefined
  );
}

export function sqlBody(sql: string): Body {
  return { sql, vars: [] };
}

export function sourcesBodyOf(
  sql: string,
  sources: readonly SqlMembershipSource[],
  user: string,
): Body {
  return {
    sql,
    vars: sources.map(
      (source, index) =>
        `${sourceUser(index)} ${source.sql.userType} := ${user};`,
    ),
  };
}

/** SQL reading the memo at `key`: a text value, or null when unset. */
function memoReadSql(api: "better-supabase" | undefined, key: string): string {
  return api === "better-supabase"
    ? `better_supabase.memo_get(${key})`
    : `nullif(current_setting(${key}, true), '')`;
}

/** SQL writing `value` to the memo at `key`. */
export function memoWriteSql(
  api: "better-supabase" | undefined,
  key: string,
  value: string,
): string {
  return api === "better-supabase"
    ? `better_supabase.memo_set(${key}, ${value})`
    : `set_config(${key}, ${value}, true)`;
}

/**
 * The volatile memo for a relation-id helper. A generation bump misses, so a
 * fresh evaluation that denies is not answered from an earlier allow.
 */
export function memoizedSetofSql(input: {
  readonly fn: string;
  readonly param: string;
  readonly returns: string;
  readonly idType: string;
  readonly scope: string;
  readonly keySql: string;
  readonly userSql: string;
  readonly query: string;
  readonly api?: "better-supabase";
  readonly grants: string;
}): string {
  const disc = memoDiscriminatorSql("v_user", input.keySql);
  const read = memoReadSql(input.api, "v_key");
  const write = memoWriteSql(
    input.api,
    "v_key",
    "jsonb_build_object('k', v_disc, 'ids', to_jsonb(v_ids))::text",
  );
  return `create or replace function ${input.fn}(${input.param})
returns ${input.returns}
language plpgsql
volatile
security definer
cost 1000
set search_path = ''
as $$
declare
  v_user text := ${input.userSql}::text;
  v_key text := 'permdock.m.' || ${quoteLiteral(input.scope)} || '.k' || (hashtext(${input.keySql}) & 1023)::text;
  v_disc text := ${disc};
  v_memo text := ${read};
  v_ids ${input.idType}[];
begin
  if v_memo is not null and (v_memo::jsonb ->> 'k') = v_disc then
    v_ids := array(select jsonb_array_elements_text(v_memo::jsonb -> 'ids')::${input.idType});
  else
    v_ids := array(
${input.query}
    );
    perform ${write};
  end if;
  return query select unnest(v_ids);
end;
$$;
${input.grants}`;
}

/**
 * Ids from a memoized helper. A hit reads the stored ids and does not call the
 * helper; a miss calls it, which stores them. The key matches the helper's.
 */
export function memoHitList(
  scope: string,
  keySql: string,
  call: string,
  userSql: string,
  api?: "better-supabase",
  idType = "text",
): string {
  const setting = `'permdock.m.' || ${quoteLiteral(scope)} || '.k' || (hashtext(${keySql}) & 1023)::text`;
  const disc = memoDiscriminatorSql(userSql, keySql);
  const read =
    api === "better-supabase"
      ? `nullif(better_supabase.memo_get(${setting}), '')::jsonb`
      : `nullif(current_setting(${setting}, true), '')::jsonb`;
  return `select e::${idType} from jsonb_array_elements_text(case when (${read} ->> 'k') = ${disc} then ${read} -> 'ids' else to_jsonb(array(select * from ${call})) end) s(e)`;
}

function memoDiscriminatorSql(user: string, key: string): string {
  return `md5(concat_ws('|',
      ${user},
      ${key},
      coalesce((select auth.jwt()) ->> 'authz_ver', ''),
      coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
      coalesce((select auth.jwt()) ->> 'session_id', ''),
      statement_timestamp()::text
    ))`;
}

/** The planner's row estimate for a memoised id-set helper. */
const SETOF_ROWS = 10;

/**
 * `language sql`, or `plpgsql` returning the query when the body declares
 * variables.
 */
export function functionBody(
  body: Body,
  parallelSafe = false,
  setof = false,
): string {
  const planner = `cost 1000${setof ? `\nrows ${String(SETOF_ROWS)}` : ""}${parallelSafe ? "\nparallel safe" : ""}`;
  if (body.memo !== undefined) {
    const declare = [
      ...body.vars,
      `v_user text := ${body.memo.user}::text;`,
      `v_key text := 'permdock.m.' || ${quoteLiteral(body.memo.scope)} || '.k' || (hashtext(p_grant) & 1023)::text;`,
      `v_disc text := ${memoDiscriminatorSql("v_user", "p_grant")};`,
      `v_memo text := ${memoReadSql(body.memo.api, "v_key")};`,
    ];
    if (body.memo.type === "boolean") {
      return `language plpgsql
volatile
security definer
cost 1000
set search_path = ''
as $$
declare
${[...declare, "v_has boolean;"].map((line) => `  ${line}`).join("\n")}
begin
  if v_memo is not null and (v_memo::jsonb ->> 'k') = v_disc then
    return (v_memo::jsonb ->> 'v')::boolean;
  end if;
  v_has := (
${body.sql}
  );
  perform ${memoWriteSql(body.memo.api, "v_key", "jsonb_build_object('k', v_disc, 'v', v_has)::text")};
  return v_has;
end;
$$;`;
    }
    declare.push(`v_ids ${body.memo.type}[];`);
    // A `setof` helper is estimated at 1,000 rows. A user holds a handful of scope
    // instances, so a small estimate keeps `id in (select helper())` off a hash join.
    return `language plpgsql
volatile
security definer
cost 1000
rows ${SETOF_ROWS}
set search_path = ''
as $$
declare
${declare.map((line) => `  ${line}`).join("\n")}
begin
  if v_memo is not null and (v_memo::jsonb ->> 'k') = v_disc then
    v_ids := array(select jsonb_array_elements_text(v_memo::jsonb -> 'ids')::${body.memo.type});
  else
    v_ids := array(
${body.sql}
    );
    perform ${memoWriteSql(body.memo.api, "v_key", "jsonb_build_object('k', v_disc, 'ids', to_jsonb(v_ids))::text")};
  end if;
  return query select unnest(v_ids);
end;
$$;`;
  }
  if (body.vars.length === 0) {
    return `language sql
stable
security definer
${planner}
set search_path = ''
as $$
${body.sql}
$$;`;
  }
  return `language plpgsql
stable
security definer
${planner}
set search_path = ''
as $$
declare
${body.vars.map((line) => `  ${line}`).join("\n")}
begin
  return query
${body.sql};
end;
$$;`;
}

/**
 * `ms.id` for the scope itself and `ms.within ->> name` for an ancestor. The
 * alias is not `s`, which `activeRowSql` binds inside its `exists`.
 */
export function sourceIdOf(scope: string): (name: string) => string {
  return (name) =>
    name === scope ? "ms.id" : `ms.within ->> ${quoteLiteral(name)}`;
}

export function sourceFilters(
  ctx: RlsSqlContext,
  scope: string,
  user: string = subjectIdSql(ctx),
  permission?: CheckedPermission,
  keeps = false,
): string {
  return [
    ...(keeps ? [`    and ${keptRowSql("ms.keep", permission)}`] : []),
    ...userActive(ctx, "    ", user),
    ...instancesActive(ctx, scope, sourceIdOf(scope), "    ", permission),
  ]
    .map((line) => `\n${line}`)
    .join("");
}

function sourcesBody(ctx: RlsSqlContext, scope: string, type: string): Body {
  const root = rootName(ctx);
  const tenant = sourceIdOf(scope)(root);
  const narrow = narrowsTo(ctx, scope)
    ? `\n    and (${activeTenant(ctx)} is null or ${tenant} = ${activeTenant(ctx)})${keyTenantLine(ctx, scope, tenant)}`
    : keyTenantLine(ctx, scope, tenant);
  const sources = scopeSources(ctx, scope);
  const set = ctx.grantSet === true;
  const rows = `  from (
${sourceRows(sources)}
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)`;
  const declared = `  select (ms.id)::${type}${set ? ", rp.grant_key" : ""}
${rows}
${rpJoin(ctx, scope, "r.role", set, "  ")}  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}${rpWhere(ctx, scope, "r.role", set, "    ")}${andLine("    ", kindFilterSql(ctx, "r.role", "ms.via"))}${narrow}${sourceFilters(ctx, scope, subjectIdSql(ctx), grantPermissionSql(set ? "rp.grant_key" : "p_grant"), sourcesKeep(sources))}`;
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return sourcesBodyOf(declared, sources, subjectIdSql(ctx));
  }
  // A custom role belongs to a tenant (or is shared by all), is held at one scope, and may be pinned to one instance of it.
  const keys = customKeysQuery(ctx, {
    scope,
    role: "r.role",
    tenant: `(${tenant})::${tenantTypeOf(ctx)}`,
    instance: "(ms.id)::text",
  });
  if (set) {
    return sourcesBodyOf(
      `${declared}
  union
  select (ms.id)::${type}, ck.grant_key
${rows}
  cross join lateral (${keys}) ck(grant_key)
  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}
    and not (r.role = any(${sqlTextArray(custom.declared)}))${narrow}${sourceFilters(ctx, scope, subjectIdSql(ctx), grantPermissionSql("ck.grant_key"), sourcesKeep(sources))}`,
      sources,
      subjectIdSql(ctx),
    );
  }
  const arrays = customKeysArrayQuery(ctx, {
    scope,
    role: "r.role",
    tenant: `(${tenant})::${tenantTypeOf(ctx)}`,
    instance: "(ms.id)::text",
  });
  return sourcesBodyOf(
    withCustomKeys(
      `  select (ms.id)::${type} as id, pdk_e.keys
${rows}
  cross join lateral (${arrays}) pdk_e
  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}
    and not (r.role = any(${sqlTextArray(custom.declared)}))${narrow}${sourceFilters(ctx, scope, subjectIdSql(ctx), grantPermissionSql("p_grant"), sourcesKeep(sources))}`,
      [declared],
      "p_grant",
    ),
    sources,
    subjectIdSql(ctx),
  );
}

export function scopedBody(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
): Body {
  if (ctx.authorize !== "database") {
    return sqlBody(claimBody(ctx, scope, type));
  }
  return scopeSources(ctx, scope).length > 0
    ? sourcesBody(ctx, scope, type)
    : sqlBody(tableBody(ctx, scope, type));
}
