import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { CheckedPermission, RlsSqlContext } from "../sql/context.ts";

import { scopeColumn } from "../../conditions/compile.ts";
import { sqlTextArray } from "../../core/sql.ts";
import {
  activeMembershipSql,
  disabledKeep,
  grantPermissionSql,
  keptRowSql,
} from "../sql/active.ts";
import { memberRoleOf, scopeSources, scopeTable } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { CUSTOM_ROLES, allowEntry, rootName, signedIn } from "../sql/shared.ts";
import {
  globalKindFilterSql,
  keyTenantSql,
  kindFilterSql,
  memberVia,
  subjectClaimJsonSql,
  subjectIdSql,
} from "../sql/subject.ts";
import { customTenantMatch } from "./custom-roles.ts";
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
    and not (${ur.roleSql} = any(${sqlTextArray(custom.declared)}))${active}`;
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
    and not (r.role = any(${sqlTextArray(custom.declared)}))${active}`;
}

export function hasBody(ctx: RlsSqlContext): string {
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
      and not (${ur.roleSql} = any(${sqlTextArray(custom.declared)}))${active}
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
    `  from ${quoteQualified(table.table)} m${role.join}`,
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
  // A custom role belongs to a tenant (or is shared by all), is held at one scope, and may be pinned to one instance of it.
  const tenantOf = tenantColumn ?? column;
  const match = [
    customTenantMatch(ctx, `${memberColumn(tenantOf)}::text`, scope, role.sql),
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
      `  from ${quoteQualified(table.table)} m${role.join}`,
      customKeysJoin(ctx, scope, ...entries),
      ...filtersFor("ck.grant_key"),
      `    and not (${role.sql} = any(${sqlTextArray(custom.declared)}))`,
    ].join("\n");
  }
  return [
    ...lines,
    "  union",
    `  select ${memberColumn(column)}::${type}`,
    `  from ${quoteQualified(table.table)} m${role.join}`,
    ...filters,
    `    and not (${role.sql} = any(${sqlTextArray(custom.declared)}))`,
    customKeysSql(ctx, scope, ...entries),
  ].join("\n");
}

/** The membership's instance of the first scope, from the canonical claim. */
export function claimTenant(ctx: RlsSqlContext, scope: string): string {
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
export type Body = { readonly sql: string; readonly vars: readonly string[] };

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

/**
 * `language sql`, or `plpgsql` returning the query when the body declares
 * variables.
 */
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
  join ${qualified(ctx, "role_permissions")} rp on rp.role = r.role
  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}${set ? "" : "\n    and rp.grant_key = p_grant"}
    and rp.scope = ${quoteLiteral(scope)}${andLine("    ", kindFilterSql(ctx, "r.role", "ms.via"))}${narrow}${sourceFilters(ctx, scope, subjectIdSql(ctx), grantPermissionSql(set ? "rp.grant_key" : "p_grant"), sourcesKeep(sources))}`;
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return sourcesBodyOf(declared, sources, subjectIdSql(ctx));
  }
  // A custom role belongs to a tenant (or is shared by all), is held at one scope, and may be pinned to one instance of it.
  const match = [
    customTenantMatch(ctx, `(${tenant})::text`, scope, "r.role"),
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
  entries(CUSTOM_ROLES.permissions, allowEntry(ctx), " and c.effect = 'allow'"),
  entries(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'deny'"),
  entries(CUSTOM_ROLES.includes, "include_role", ""),
)}
  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}
    and not (r.role = any(${sqlTextArray(custom.declared)}))${narrow}${sourceFilters(ctx, scope, subjectIdSql(ctx), grantPermissionSql("ck.grant_key"), sourcesKeep(sources))}`,
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
    and not (r.role = any(${sqlTextArray(custom.declared)}))${narrow}${sourceFilters(ctx, scope, subjectIdSql(ctx), grantPermissionSql("p_grant"), sourcesKeep(sources))}
${customKeysSql(
  ctx,
  scope,
  entries(CUSTOM_ROLES.permissions, allowEntry(ctx), " and c.effect = 'allow'"),
  entries(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'deny'"),
  entries(CUSTOM_ROLES.includes, "include_role", ""),
)}`,
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
