import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { RoleRows } from "./global-roles.ts";
import type { CheckedPermission, RlsSqlContext } from "./rls-sql.ts";

import { scopeColumn } from "../conditions/compile.ts";
import { globalRoleSource } from "./global-roles.ts";
import {
  apiKeyAllowsCall,
  apiKeyAllowsSql,
  ceilingHasSql,
  ceilingIdsSql,
  serviceKeyIdsSql,
  serviceKeyMemberSql,
} from "./rls-api-keys.ts";
import {
  customRoleCascadeSql,
  customRolesSql,
  customRoleWritesSql,
  roleReadersSql,
} from "./rls-custom-roles.ts";
import {
  allowEntry,
  CUSTOM_ROLES,
  HELPERS,
  helperSchema,
  qualified,
  rootName,
  signedIn,
  textArray,
} from "./rls-shared.ts";
import {
  activeInstancesSql,
  activeMembershipSql,
  activeUserSql,
  disabledKeep,
  globalKindFilterSql,
  grantPermissionSql,
  hasMemberFor,
  keptRowSql,
  keyTenantSql,
  kindFilterSql,
  memberForHelper,
  memberForSources,
  memberIdsHelper,
  memberRoleOf,
  memberVia,
  permittedForHelper,
  permittedIdsHelper,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  scopeSources,
  scopeTable,
  scopeTypeOf,
  subjectClaimJsonSql,
  subjectClaimSql,
  subjectIdSql,
  userIdHelperSql,
} from "./rls-sql.ts";

/** The helper `--capabilities` adds: ids of one resource a link capability claim reaches. Part of the SQL contract. */
const CAPABILITIES = {
  ids: "permdock_capability_ids",
} as const;

/** `'global'` or a scope name. */
export type HelperScope = string;

/** One `role_permissions` row: `role` holds `grant_key`, which is `permission` or `permission#n`. */
export type RolePermission = {
  readonly role: string;
  readonly permission: string;
  readonly grantKey: string;
  readonly scope: HelperScope;
  readonly effect: "allow" | "deny";
};

/**
 * The policy-side call for a grant key. Every form is uncorrelated, so
 * Postgres runs the helper once per statement (an InitPlan, or a hashed
 * SubPlan for `in`), never once per row.
 */
export function accessSql(
  ctx: RlsSqlContext,
  scope: HelperScope,
  grantKey: string,
  column: string | undefined,
): string {
  const key = quoteLiteral(grantKey);
  if (scope === "global") {
    return `(select ${qualified(ctx, HELPERS.has)}(${key}))`;
  }
  if (column === undefined) {
    throw new Error(
      `PermDock CLI: ${scope}-scoped grant needs definePolicy({ scopes.${scope} })`,
    );
  }
  return `${quoteIdent(column)} in (select ${qualified(ctx, permittedIdsHelper(scope))}(${key}))`;
}

/**
 * The `anon` branch access for a resource-scoped grant reached through a link
 * capability: the row's `field` holds an id the capability claim names for
 * `resource`, `role` and `permission`. Uncorrelated, so it runs once per
 * statement; the column is compared as text because the claim holds text.
 */
export function capabilityAccessSql(
  ctx: RlsSqlContext,
  field: string,
  resource: string,
  role: string,
  permission: string,
): string {
  const args = [resource, role, permission].map(quoteLiteral).join(", ");
  return `${quoteIdent(field)}::text in (select ${qualified(ctx, CAPABILITIES.ids)}(${args}))`;
}

function capabilitiesSql(ctx: RlsSqlContext): string {
  if (ctx.capabilities !== true) {
    return "";
  }
  const fn = qualified(ctx, CAPABILITIES.ids);
  const claim = subjectClaimJsonSql(ctx, "capability");
  return `-- link capabilities: the capability claim exchangeCapability mints (role anon, short-lived)
create or replace function ${fn}(p_resource text, p_role text, p_permission text)
returns setof text
language sql
stable
set search_path = ''
as $$
  select c -> 'on' ->> 'id'
  from (select ${claim} as c) capability
  where jsonb_typeof(c) = 'object'
    and c ->> 'v' = '1'
    and c ->> 'holder' = 'link'
    and c -> 'on' ->> 'resource' = p_resource
    and jsonb_typeof(c -> 'roles') = 'array'
    and c -> 'roles' @> jsonb_build_array(p_role)
    and (c -> 'permissions' is null or c -> 'permissions' @> jsonb_build_array(p_permission))
    and jsonb_typeof(c -> 'expiresAt') = 'number'
    and (c ->> 'expiresAt')::numeric > extract(epoch from now())
$$;
revoke execute on function ${fn}(text, text, text) from public;
grant execute on function ${fn}(text, text, text) to anon, authenticated;`;
}

function userIdSql(ctx: RlsSqlContext, anonExecute: boolean): string {
  const fn = userIdHelperSql(ctx);
  const grants = anonExecute
    ? `revoke execute on function ${fn}() from public;
grant execute on function ${fn}() to anon, authenticated;`
    : `revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;`;
  return `-- the caller's user id: the sub of request.jwt.claims, or null when it is empty or absent
create or replace function ${fn}()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid
$$;
${grants}`;
}

export function membershipTable(name: string): string {
  return quoteTable(name.includes(".") ? name : `public.${name}`);
}

function activeTenant(ctx: RlsSqlContext): string {
  return `nullif(${subjectClaimSql(ctx, ctx.tenantClaim)}, '')`;
}

function keyTenantLine(
  ctx: RlsSqlContext,
  scope: string,
  tenant: string,
): string {
  const keyed = keyTenantSql(ctx, underRoot(ctx, scope) ? tenant : undefined);
  return keyed === undefined ? "" : `\n    and ${keyed}`;
}

/** Whether the helper for `scope` narrows to the tenant claim: unless `rls.tenants` is `'all'`, when the first scope is on its chain. */
function narrowsTo(ctx: RlsSqlContext, scope: string): boolean {
  return ctx.tenants !== "all" && underRoot(ctx, scope);
}

/** Whether the active tenant narrows memberships of `scope`: the first scope is on its chain. */
function underRoot(ctx: RlsSqlContext, scope: string): boolean {
  const root = ctx.scopes[0]?.name;
  let current = ctx.scopes.find((item) => item.name === scope);
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.name)) {
    if (current.name === root) {
      return true;
    }
    seen.add(current.name);
    const parent: string | undefined = current.within;
    current =
      parent === undefined
        ? undefined
        : ctx.scopes.find((item) => item.name === parent);
  }
  return false;
}

/** `and exists (...)` lines for an active user; empty without `rls.suspension.users`. */
function userActive(
  ctx: RlsSqlContext,
  indent: string,
  user?: string,
): string[] {
  return activeUserSql(ctx, user).map((part) => `${indent}and ${part}`);
}

/** `and exists (...)` lines for every suspendable instance on the chain of `scope`'s membership. */
function instancesActive(
  ctx: RlsSqlContext,
  scope: string,
  idOf: (name: string) => string | undefined,
  indent: string,
  permission?: CheckedPermission,
): string[] {
  return activeInstancesSql(ctx, scope, idOf, permission).map(
    (part) => `${indent}and ${part}`,
  );
}

export function roleRows(ctx: RlsSqlContext): string {
  const claim = ctx.roleClaim ?? "user_role";
  switch (ctx.dialect) {
    case "guc":
      return `unnest(string_to_array(nullif(current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true), ''), ',')) r(role)`;
    case "supabase":
    case "neon": {
      const raw = subjectClaimJsonSql(ctx, claim);
      // A top-level null falls back to app_metadata, like subjectFromSupabase.
      const value =
        ctx.dialect === "supabase"
          ? `coalesce(nullif(${raw}, 'null'::jsonb), (select auth.jwt()) -> 'app_metadata' -> ${quoteLiteral(claim)})`
          : raw;
      return `jsonb_array_elements_text(
      case jsonb_typeof(${value})
        when 'array' then ${value}
        when 'string' then jsonb_build_array(${value})
        else '[]'::jsonb
      end
    ) r(role)`;
    }
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

export function membershipRows(ctx: RlsSqlContext): string {
  const raw = subjectClaimJsonSql(ctx, "memberships");
  const value =
    ctx.dialect === "supabase"
      ? `coalesce(${raw}, (select auth.jwt()) -> 'app_metadata' -> 'memberships')`
      : raw;
  return `jsonb_array_elements(
      case jsonb_typeof(${value}) when 'array' then ${value} else '[]'::jsonb end
    ) m
    cross join lateral jsonb_array_elements_text(
      case jsonb_typeof(m -> 'roles') when 'array' then m -> 'roles' else '[]'::jsonb end
    ) r(role)`;
}

function andLine(indent: string, condition: string | undefined): string {
  return condition === undefined ? "" : `\n${indent}and ${condition}`;
}

/** `rls.roles`, or the generated `user_roles (user_id, role)`, aliased `ur`. */
export function globalRoleRows(
  ctx: RlsSqlContext,
): Pick<RoleRows, "from" | "userSql" | "roleSql"> {
  return ctx.roles === undefined
    ? {
        from: `${qualified(ctx, "user_roles")} ur`,
        userSql: "ur.user_id",
        roleSql: "ur.role::text",
      }
    : globalRoleSource(ctx.roles, "public", "ur");
}

function customKeysJoin(
  ctx: RlsSqlContext,
  scope: string,
  allows: string,
  denies: string,
  includes: string,
): string {
  return `  cross join lateral ${qualified(ctx, CUSTOM_ROLES.keys)}(
    ${allows},
    ${denies},
    ${includes},
    ${quoteLiteral(scope)}
  ) ck(grant_key)`;
}

function hasSetBody(ctx: RlsSqlContext): string {
  const rp = qualified(ctx, "role_permissions");
  const active = userActive(ctx, "    ")
    .map((line) => `\n${line}`)
    .join("");
  const custom = ctx.customRoles;
  if (ctx.authorize === "database") {
    const ur = globalRoleRows(ctx);
    const declared = `  select rp.grant_key
  from ${ur.from}
  join ${rp} rp on rp.role = ${ur.roleSql}
  where ${ur.userSql} = ${subjectIdSql(ctx)}
    and rp.scope = 'global'${andLine("    ", globalKindFilterSql(ctx, ur.roleSql))}${active}`;
    if (custom === undefined) {
      return declared;
    }
    const match = `c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ${ur.roleSql}`;
    const rows = (source: string, value: string, extra: string): string =>
      `array(select c.${value} from ${qualified(ctx, source)} c where ${match}${extra})`;
    return `${declared}
  union
  select ck.grant_key
  from ${ur.from}
${customKeysJoin(
  ctx,
  "global",
  rows(CUSTOM_ROLES.permissions, allowEntry(ctx), " and c.effect = 'allow'"),
  rows(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'deny'"),
  rows(CUSTOM_ROLES.includes, "include_role", ""),
)}
  where ${ur.userSql} = ${subjectIdSql(ctx)}
    and not (${ur.roleSql} = any(${textArray(custom.declared)}))${active}`;
  }
  const declared = `  select rp.grant_key
  from ${roleRows(ctx)}
  join ${rp} rp on rp.role = r.role
  where ${signedIn(ctx)}
    and rp.scope = 'global'${andLine("    ", globalKindFilterSql(ctx, "r.role"))}${active}`;
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
    and not (r.role = any(${textArray(custom.declared)}))${active}`;
}

function hasBody(ctx: RlsSqlContext): string {
  if (ctx.grantSet === true) {
    return hasSetBody(ctx);
  }
  const rp = qualified(ctx, "role_permissions");
  const active = userActive(ctx, "      ")
    .map((line) => `\n${line}`)
    .join("");
  const custom = ctx.customRoles;
  if (ctx.authorize === "database") {
    const ur = globalRoleRows(ctx);
    const declared = `  select exists (
    select 1
    from ${ur.from}
    join ${rp} rp on rp.role = ${ur.roleSql}
    where ${ur.userSql} = ${subjectIdSql(ctx)}
      and rp.grant_key = p_grant
      and rp.scope = 'global'${andLine("      ", globalKindFilterSql(ctx, ur.roleSql))}${active}
  )`;
    if (custom === undefined) {
      return declared;
    }
    // A platform custom role: rows with no tenant at scope global, held through the global roles table.
    const match = `c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ${ur.roleSql}`;
    const rows = (source: string, value: string, extra: string): string =>
      `array(select c.${value} from ${qualified(ctx, source)} c where ${match}${extra})`;
    return `${declared}
  or exists (
    select 1
    from ${ur.from}
    where ${ur.userSql} = ${subjectIdSql(ctx)}
      and not (${ur.roleSql} = any(${textArray(custom.declared)}))${active}
      ${customKeysSql(
        ctx,
        "global",
        rows(
          CUSTOM_ROLES.permissions,
          allowEntry(ctx),
          " and c.effect = 'allow'",
        ),
        rows(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'deny'"),
        rows(CUSTOM_ROLES.includes, "include_role", ""),
      ).trimStart()}
  )`;
  }
  const declared = `  select ${signedIn(ctx)} and exists (
    select 1
    from ${roleRows(ctx)}
    join ${rp} rp on rp.role = r.role
    where rp.grant_key = p_grant
      and rp.scope = 'global'${andLine("      ", globalKindFilterSql(ctx, "r.role"))}${active}
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
      and not (r.role = any(${textArray(custom.declared)}))${active}
      ${customKeysSql(
        ctx,
        "global",
        claimEntries("left(e, 1) not in ('-', '@')", "e"),
        claimEntries("left(e, 1) = '-'", "substr(e, 2)"),
        claimEntries("left(e, 1) = '@'", "substr(e, 2)"),
      ).trimStart()}
  ))`;
}

/** The claim `jwt` mode reads platform custom roles from: `customRoleClaim(globalRoles)`. */
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

function tableBody(ctx: RlsSqlContext, scope: string, type: string): string {
  const mapped = scopeTable(ctx, scope);
  if (mapped === undefined) {
    return `  select null::${type} where false -- no ${scope} memberships table configured`;
  }
  const { table, column, tenantColumn } = mapped;
  const set = ctx.grantSet === true;
  const filtersFor = (grant: string): string[] => {
    const filters = [
      `  where ${memberColumn(table.user)} = ${subjectIdSql(ctx)}`,
    ];
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
    filters.push(
      ...userActive(ctx, "    "),
      ...instancesActive(
        ctx,
        scope,
        (name) => {
          const held = scopeColumn(table, ctx.scopes, name);
          return held === undefined ? undefined : memberColumn(held);
        },
        "    ",
        grantPermissionSql(grant),
      ),
    );
    return filters;
  };
  const filters = filtersFor(set ? "rp.grant_key" : "p_grant");
  const [owner, ...rest] = filters;
  const role = memberRoleOf(table, "m", "  ");
  const kind = kindFilterSql(ctx, role.sql, memberVia(table));
  const lines = [
    `  select${role.lateral ? " distinct" : ""} ${memberColumn(column)}::${type}${set ? ", rp.grant_key" : ""}`,
    `  from ${membershipTable(table.table)} m${role.join}`,
    `  join ${qualified(ctx, "role_permissions")} rp on rp.role = ${role.sql}`,
    owner ?? "",
    ...(set ? [] : ["    and rp.grant_key = p_grant"]),
    `    and rp.scope = ${quoteLiteral(scope)}`,
    ...(kind === undefined ? [] : [`    and ${kind}`]),
    ...rest,
  ];
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return lines.join("\n");
  }
  // A custom role belongs to a tenant, is held at one scope, and may be pinned to one instance of it.
  const tenantOf = tenantColumn ?? column;
  const match = [
    `c.tenant_id::text = ${memberColumn(tenantOf)}::text`,
    `c.scope = ${quoteLiteral(scope)}`,
    `(c.scope_id is null or c.scope_id = ${memberColumn(column)}::text)`,
    `c.role = ${role.sql}`,
  ].join(" and ");
  const rows = (source: string, value: string, extra: string): string =>
    `array(select c.${value} from ${qualified(ctx, source)} c where ${match}${extra})`;
  const entries = [
    rows(CUSTOM_ROLES.permissions, allowEntry(ctx), " and c.effect = 'allow'"),
    rows(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'deny'"),
    rows(CUSTOM_ROLES.includes, "include_role", ""),
  ] as const;
  if (set) {
    return [
      ...lines,
      "  union",
      `  select ${memberColumn(column)}::${type}, ck.grant_key`,
      `  from ${membershipTable(table.table)} m${role.join}`,
      customKeysJoin(ctx, scope, ...entries),
      ...filtersFor("ck.grant_key"),
      `    and not (${role.sql} = any(${textArray(custom.declared)}))`,
    ].join("\n");
  }
  return [
    ...lines,
    "  union",
    `  select ${memberColumn(column)}::${type}`,
    `  from ${membershipTable(table.table)} m${role.join}`,
    ...filters,
    `    and not (${role.sql} = any(${textArray(custom.declared)}))`,
    customKeysSql(ctx, scope, ...entries),
  ].join("\n");
}

/** The membership's instance of the first scope, from the canonical claim. */
function claimTenant(ctx: RlsSqlContext, scope: string): string {
  const root = rootName(ctx);
  return scope === root
    ? `m ->> 'id'`
    : `m -> 'within' ->> ${quoteLiteral(root)}`;
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
    and case jsonb_typeof(m -> 'expiresAt')
      when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
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
  join ${qualified(ctx, "role_permissions")} rp on rp.role = r.role
  where ${signedIn(ctx)}${set ? "" : "\n    and rp.grant_key = p_grant"}
    and rp.scope = ${quoteLiteral(scope)}${andLine("    ", kindFilterSql(ctx, "r.role", "m ->> 'via'"))}
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
    and not (r.role = any(${textArray(custom.declared)}))
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
    and not (r.role = any(${textArray(custom.declared)}))
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
 * (`scope`, `id`, `within`, `roles`, `via`), with each source's own expiry
 * and suspension filters: the statements the token hook runs.
 */
export function sourcesKeep(sources: readonly SqlMembershipSource[]): boolean {
  return sources.some((source) => source.sql.keeps);
}

function sourceRows(sources: readonly SqlMembershipSource[]): string {
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
};

function sqlBody(sql: string): Body {
  return { sql, vars: [] };
}

function sourcesBodyOf(
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

/** `language sql`, or `plpgsql` returning the query when the body declares variables. */
export function functionBody(body: Body): string {
  if (body.vars.length === 0) {
    return `language sql
stable
security definer
set search_path = ''
as $$
${body.sql}
$$;`;
  }
  return `language plpgsql
stable
security definer
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
function sourceIdOf(scope: string): (name: string) => string {
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
  join ${qualified(ctx, "role_permissions")} rp on rp.role = r.role
  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}${set ? "" : "\n    and rp.grant_key = p_grant"}
    and rp.scope = ${quoteLiteral(scope)}${andLine("    ", kindFilterSql(ctx, "r.role", "ms.via"))}${narrow}${sourceFilters(ctx, scope, subjectIdSql(ctx), grantPermissionSql(set ? "rp.grant_key" : "p_grant"), sourcesKeep(sources))}`;
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return sourcesBodyOf(declared, sources, subjectIdSql(ctx));
  }
  // A custom role belongs to a tenant, is held at one scope, and may be pinned to one instance of it.
  const match = [
    `c.tenant_id::text = (${tenant})::text`,
    `c.scope = ${quoteLiteral(scope)}`,
    "(c.scope_id is null or c.scope_id = (ms.id)::text)",
    "c.role = r.role",
  ].join(" and ");
  const entries = (source: string, value: string, extra: string): string =>
    `array(select c.${value} from ${qualified(ctx, source)} c where ${match}${extra})`;
  if (set) {
    return sourcesBodyOf(
      `${declared}
  union
  select (ms.id)::${type}, ck.grant_key
${rows}
${customKeysJoin(
  ctx,
  scope,
  entries(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'allow'"),
  entries(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'deny'"),
  entries(CUSTOM_ROLES.includes, "include_role", ""),
)}
  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}
    and not (r.role = any(${textArray(custom.declared)}))${narrow}${sourceFilters(ctx, scope, subjectIdSql(ctx), grantPermissionSql("ck.grant_key"), sourcesKeep(sources))}`,
      sources,
      subjectIdSql(ctx),
    );
  }
  return sourcesBodyOf(
    `${declared}
  union
  select (ms.id)::${type}
${rows}
  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}
    and not (r.role = any(${textArray(custom.declared)}))${narrow}${sourceFilters(ctx, scope, subjectIdSql(ctx), grantPermissionSql("p_grant"), sourcesKeep(sources))}
${customKeysSql(
  ctx,
  scope,
  entries(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'allow'"),
  entries(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'deny'"),
  entries(CUSTOM_ROLES.includes, "include_role", ""),
)}`,
    sources,
    subjectIdSql(ctx),
  );
}

function scopedBody(ctx: RlsSqlContext, scope: string, type: string): Body {
  if (ctx.authorize !== "database") {
    return sqlBody(claimBody(ctx, scope, type));
  }
  return scopeSources(ctx, scope).length > 0
    ? sourcesBody(ctx, scope, type)
    : sqlBody(tableBody(ctx, scope, type));
}

/**
 * The body of `member_<scope>_ids()`: instances of `scope` the subject holds
 * a live membership of, with any role. Not narrowed to the active tenant, and
 * no cascade: a membership of a child scope is not one of its parent.
 */
function memberBody(ctx: RlsSqlContext, scope: string, type: string): Body {
  if (ctx.authorize !== "database") {
    return sqlBody(`  select distinct (m ->> 'id')::${type}
  from jsonb_array_elements(
    case jsonb_typeof(${membershipClaim(ctx)}) when 'array' then ${membershipClaim(ctx)} else '[]'::jsonb end
  ) m
  where ${signedIn(ctx)}
    and m ->> 'scope' = ${quoteLiteral(scope)}
    and m ->> 'id' is not null${keyTenantLine(ctx, scope, claimTenant(ctx, scope))}
    and jsonb_typeof(m -> 'roles') = 'array'
    and jsonb_array_length(m -> 'roles') > 0
    and case jsonb_typeof(m -> 'expiresAt')
      when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
      else true
    end${[
      ...claimKeptLines(ctx, "    "),
      ...userActive(ctx, "    "),
      ...instancesActive(
        ctx,
        scope,
        (name) =>
          name === scope
            ? `m ->> 'id'`
            : `m -> 'within' ->> ${quoteLiteral(name)}`,
        "    ",
      ),
    ]
      .map((line) => `\n${line}`)
      .join("")}`);
  }
  return memberRowsBody(
    ctx,
    scope,
    type,
    subjectIdSql(ctx),
    scopeSources(ctx, scope),
    true,
  );
}

/**
 * The membership rows of `user` for `scope`, from the sources or else the
 * mapped table, with the same expiry and suspension filters either way.
 */
function memberRowsBody(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
  user: string,
  sources: readonly SqlMembershipSource[],
  keyed = false,
): Body {
  if (sources.length > 0) {
    const narrow = keyed
      ? keyTenantLine(ctx, scope, sourceIdOf(scope)(rootName(ctx)))
      : "";
    return sourcesBodyOf(
      `  select distinct (ms.id)::${type}
  from (
${sourceRows(sources)}
  ) ms
  where ${signedIn(ctx, user)}
    and ms.scope = ${quoteLiteral(scope)}
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0${narrow}${sourceFilters(ctx, scope, user, undefined, sourcesKeep(sources))}`,
      sources,
      user,
    );
  }
  const mapped = scopeTable(ctx, scope);
  if (mapped === undefined) {
    return sqlBody(
      `  select null::${type} where false -- no ${scope} memberships table configured`,
    );
  }
  const { table, column, tenantColumn } = mapped;
  const role = memberRoleOf(table, "m", "  ");
  const lines = [
    `  select distinct ${memberColumn(column)}::${type}`,
    `  from ${membershipTable(table.table)} m${role.join}`,
    `  where ${memberColumn(table.user)} = ${user}`,
    `    and ${role.through === undefined && !role.lateral ? memberColumn(role.column) : role.sql} is not null`,
  ];
  const narrow = keyed
    ? keyTenantSql(
        ctx,
        tenantColumn === undefined ? undefined : memberColumn(tenantColumn),
      )
    : undefined;
  if (narrow !== undefined) {
    lines.push(`    and ${narrow}`);
  }
  if (table.expiresAt !== undefined) {
    const expires = memberColumn(table.expiresAt);
    lines.push(`    and (${expires} is null or ${expires} > now())`);
  }
  lines.push(
    ...activeMembershipSql(ctx, disabledColumn(table), undefined).map(
      (part) => `    and ${part}`,
    ),
    ...userActive(ctx, "    ", user),
    ...instancesActive(
      ctx,
      scope,
      (name) => {
        const held = scopeColumn(table, ctx.scopes, name);
        return held === undefined ? undefined : memberColumn(held);
      },
      "    ",
    ),
  );
  return sqlBody(lines.join("\n"));
}

function membershipClaim(ctx: RlsSqlContext): string {
  const raw = subjectClaimJsonSql(ctx, "memberships");
  return ctx.dialect === "supabase"
    ? `coalesce(${raw}, (select auth.jwt()) -> 'app_metadata' -> 'memberships')`
    : raw;
}

function memberFunction(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
  anonExecute: boolean,
): string {
  const fn = qualified(ctx, memberIdsHelper(scope));
  const body = memberBody(ctx, scope, type);
  const keys = ctx.apiKeys;
  const keyed =
    keys === undefined || scope !== rootName(ctx)
      ? body
      : {
          sql: `${body.sql}\n  union\n${serviceKeyMemberSql(ctx, keys, scope, type)}`,
          vars: body.vars,
        };
  const grants = anonExecute
    ? `revoke execute on function ${fn}() from public;
grant execute on function ${fn}() to anon, authenticated;`
    : `revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;`;
  return `create or replace function ${fn}()
returns setof ${type}
${functionBody(keyed)}
${grants}`;
}

/**
 * `member_<scope>_ids_for(p_user uuid)`: `member_<scope>_ids()` for a user the
 * caller names, read from the membership sources (or the mapped table) in
 * either mode, so a token hook can call it before any claim exists. Naming
 * the user is why no client role may execute it; the hook's grants give
 * `supabase_auth_admin` execute.
 */
function memberForFunction(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
): string {
  const fn = qualified(ctx, memberForHelper(scope));
  const body = memberRowsBody(
    ctx,
    scope,
    type,
    "p_user",
    memberForSources(ctx, scope),
  );
  return `create or replace function ${fn}(p_user uuid)
returns setof ${type}
${functionBody(body)}
revoke execute on function ${fn}(uuid) from public, anon, authenticated;`;
}

function helperFunction(
  ctx: RlsSqlContext,
  name: string,
  returns: string,
  body: Body,
  anonExecute: boolean,
): string {
  const fn = qualified(ctx, name);
  const grants = anonExecute
    ? `revoke execute on function ${fn}(text) from public;
grant execute on function ${fn}(text) to anon, authenticated;`
    : `revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
  return `create or replace function ${fn}(p_grant text)
returns ${returns}
${functionBody(body)}
${grants}`;
}

/**
 * `permdock_has_for(p_user, p_grant)` and one
 * `permitted_<scope>_ids_for(p_user, p_grant)` per scope in `database` mode:
 * the bodies of `permdock_has` and `permitted_<scope>_ids` with `p_user` for
 * the signed-in user and no tenant-claim narrowing, since a named user has
 * no token. For trusted SQL that acts for a stored user (jobs, triggers,
 * approvals resolved later). Naming the user is why no client role may
 * execute them: `security definer` callers run them as their owner, and a
 * backend role needs its own grant.
 */
function forUserSql(ctx: RlsSqlContext): string {
  if (ctx.authorize !== "database") {
    return "";
  }
  const forUser = forUserContext(ctx);
  const type = ctx.dialect === "supabase" ? "uuid" : "text";
  const fn = (name: string, returns: string, body: Body): string => {
    const qualifiedName = qualified(ctx, name);
    return `create or replace function ${qualifiedName}(p_user ${type}, p_grant text)
returns ${returns}
${functionBody(body)}
revoke execute on function ${qualifiedName}(${type}, text) from public, anon, authenticated;`;
  };
  return [
    `-- the helpers for a user the caller names: trusted SQL acting for a stored user; no client role may execute them
${fn(HELPERS.hasFor, "boolean", sqlBody(hasBody(forUser)))}`,
    ...ctx.scopes.map((scope) => {
      const scopeType = scopeTypeOf(ctx, scope.name);
      return fn(
        permittedForHelper(scope.name),
        `setof ${scopeType}`,
        scopedBody(forUser, scope.name, scopeType),
      );
    }),
  ].join("\n\n");
}

function userIdType(ctx: RlsSqlContext): string {
  return ctx.dialect === "supabase"
    ? "uuid not null references auth.users on delete cascade"
    : "text not null";
}

/**
 * The `role_permissions` rows the policy compiles to: an upsert and a delete
 * of every other row. Data, not schema, so `supabase db diff` drops it from a
 * declarative schema; `--split ...,seeds` writes it as its own migration.
 */
export function seedSql(
  ctx: RlsSqlContext,
  rows: readonly RolePermission[],
): string {
  const table = qualified(ctx, "role_permissions");
  if (rows.length === 0) {
    return `delete from ${table};`;
  }
  const values = rows
    .map(
      (row) =>
        `  (${[row.role, row.permission, row.grantKey, row.scope, row.effect].map(quoteLiteral).join(", ")})`,
    )
    .join(",\n");
  const keys = rows
    .map(
      (row) =>
        `  (${[row.role, row.grantKey, row.scope].map(quoteLiteral).join(", ")})`,
    )
    .join(",\n");
  return `insert into ${table} (role, permission, grant_key, scope, effect) values
${values}
on conflict (role, grant_key, scope) do update
  set permission = excluded.permission, effect = excluded.effect;
delete from ${table}
where (role, grant_key, scope) not in (values
${keys}
);`;
}

export type HelpersOptions = {
  /** Emit a `user_roles` table for `database` mode; off when the RBAC scaffold owns it. */
  readonly userRoles: boolean;
  /**
   * Let `anon` execute the helpers: a field view `anon` reads calls them, and
   * Postgres checks `execute` on every function in a view before it runs. They
   * find no subject for `anon` and return nothing.
   */
  readonly anonExecute?: boolean;
  /** Leave the `role_permissions` rows out: the `seeds` split part writes them. */
  readonly withoutSeeds?: boolean;
  /** `[grant key, level]` pairs from `compileGrants`, for the custom-role writes. */
  readonly levelReach?: readonly (readonly [string, string])[];
  /** Every declared permission key, for `permdock_permission_keys`; the function is left out without it. */
  readonly permissions?: readonly string[];
  readonly trustedReaders?: readonly string[];
};

/**
 * `role_permissions`, its seeds, and the three `security definer` helpers
 * with `search_path = ''`. `execute` goes to `authenticated` only.
 */
export function helpersSql(
  ctx: RlsSqlContext,
  rows: readonly RolePermission[],
  options: HelpersOptions,
): string {
  const schema = helperSchema(ctx);
  const s = quoteIdent(schema);
  const rp = qualified(ctx, "role_permissions");
  const chunks = [
    `-- permdock helpers (${ctx.authorize === "database" ? "database: reads the membership and user_roles tables" : "jwt: reads the role and memberships claims"})
-- policies call them uncorrelated, so Postgres evaluates each once per statement`,
  ];
  if (schema !== "public") {
    chunks.push(
      `create schema if not exists ${s};\nrevoke all on schema ${s} from public;\ngrant usage on schema ${s} to ${options.anonExecute === true ? "anon, authenticated" : "authenticated"};`,
    );
  }
  if (ctx.dialect === "supabase") {
    chunks.push(userIdSql(ctx, options.anonExecute === true));
  }
  chunks.push(`create table if not exists ${rp} (
  role text not null,
  permission text not null,
  grant_key text not null,
  scope text not null check (scope ~ '^[a-z][a-z0-9_]*$'),
  effect text not null default 'allow' check (effect in ('allow', 'deny')),
  primary key (role, grant_key, scope)
);
alter table ${rp} enable row level security;
revoke all on table ${rp} from anon, authenticated, public;`);
  if (options.withoutSeeds !== true) {
    chunks.push(seedSql(ctx, rows));
  }
  if (
    ctx.authorize === "database" &&
    options.userRoles &&
    ctx.roles === undefined
  ) {
    const ur = qualified(ctx, "user_roles");
    chunks.push(`create table if not exists ${ur} (
  user_id ${userIdType(ctx)},
  role text not null,
  primary key (user_id, role)
);
alter table ${ur} enable row level security;
revoke all on table ${ur} from anon, authenticated, public;`);
  }
  const custom = customRolesSql(ctx);
  if (custom !== "") {
    chunks.push(custom);
  }
  const anon = options.anonExecute === true;
  const keys = ctx.apiKeys;
  if (keys !== undefined) {
    chunks.push(apiKeyAllowsSql(ctx, keys, anon));
  }
  const bodies = grantBodies(ctx);
  chunks.push(helperFunction(ctx, HELPERS.has, "boolean", bodies.has, anon));
  const capabilities = capabilitiesSql(ctx);
  if (capabilities !== "") {
    chunks.push(capabilities);
  }
  for (const scope of ctx.scopes) {
    const type = scopeTypeOf(ctx, scope.name);
    chunks.push(
      helperFunction(
        ctx,
        permittedIdsHelper(scope.name),
        `setof ${type}`,
        bodies.ids(scope.name),
        anon,
      ),
    );
    chunks.push(memberFunction(ctx, scope.name, type, anon));
    if (hasMemberFor(ctx, scope.name)) {
      chunks.push(memberForFunction(ctx, scope.name, type));
    }
  }
  const forUser = forUserSql(ctx);
  if (forUser !== "") {
    chunks.push(forUser);
  }
  const writes = customRoleWritesSql(ctx, options.levelReach ?? []);
  if (writes !== "") {
    chunks.push(writes);
    const cascade = customRoleCascadeSql(ctx);
    if (cascade !== "") {
      chunks.push(cascade);
    }
  }
  const readers = roleReadersSql(
    ctx,
    options.permissions,
    options.trustedReaders,
  );
  if (readers !== "") {
    chunks.push(readers);
  }
  return `${chunks.join("\n\n")}\n`;
}

export function grantBodies(ctx: RlsSqlContext): {
  readonly has: Body;
  readonly ids: (scope: string) => Body;
} {
  const keys = ctx.apiKeys;
  const set = ctx.grantSet === true;
  const allows = apiKeyAllowsCall(ctx, set ? "ids.grant_key" : "p_grant");
  const keyTenant = keyTenantSql(ctx, undefined) ?? "true";
  return {
    has: sqlBody(
      keys === undefined
        ? hasBody(ctx)
        : set
          ? `  select g.grant_key
  from (
${hasBody(ctx)}
  ) g(grant_key)
  where ${apiKeyAllowsCall(ctx, "g.grant_key")} and ${keyTenant}`
          : ceilingHasSql(hasBody(ctx), `${allows} and ${keyTenant}`),
    ),
    ids: (scope) => {
      const type = scopeTypeOf(ctx, scope);
      const body = scopedBody(ctx, scope, type);
      if (keys === undefined) {
        return body;
      }
      const sql =
        scope === rootName(ctx)
          ? `${body.sql}\n  union\n${serviceKeyIdsSql(ctx, keys, scope, type)}`
          : body.sql;
      return {
        sql: set
          ? `  select ids.id, ids.grant_key
  from (
${sql}
  ) ids(id, grant_key)
  where ${allows}`
          : ceilingIdsSql(sql, allows),
        vars: body.vars,
      };
    },
  };
}

export function forUserContext(ctx: RlsSqlContext): RlsSqlContext {
  const { apiKeys: _apiKeys, ...unkeyed } = ctx;
  return { ...unkeyed, subjectId: "p_user", tenants: "all" };
}
