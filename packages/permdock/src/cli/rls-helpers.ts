import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { RoleRows } from "./global-roles.ts";
import type { RlsSqlContext } from "./rls-sql.ts";

import { scopeColumn } from "../conditions/compile.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import { globalRoleSource } from "./global-roles.ts";
import {
  activeInstancesSql,
  activeUserSql,
  globalKindFilterSql,
  hasMemberFor,
  kindFilterSql,
  memberForHelper,
  memberForSources,
  memberIdsHelper,
  memberRoleOf,
  memberVia,
  permittedIdsHelper,
  scopeSources,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  scopeTable,
  scopeTypeOf,
  subjectClaimJsonSql,
  subjectClaimSql,
  subjectIdSql,
  tenantTypeOf,
} from "./rls-sql.ts";

/**
 * The per-statement helpers every generated policy calls: `permdock_has` for
 * global roles and one `permitted_<scope>_ids` per scope
 * (`permittedIdsHelper`). Names are part of the SQL contract.
 */
export const HELPERS = {
  has: "permdock_has",
} as const;

/** The helper `--capabilities` adds: ids of one resource a link capability claim reaches. Part of the SQL contract. */
const CAPABILITIES = {
  ids: "permdock_capability_ids",
} as const;

/** Objects `--custom-roles` adds next to the helpers. Names are part of the SQL contract. */
const CUSTOM_ROLES = {
  permissions: "custom_role_permissions",
  includes: "custom_role_includes",
  ceiling: "permdock_ceiling",
  keys: "permdock_custom_keys",
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

function helperSchema(ctx: RlsSqlContext): string {
  return ctx.schema ?? PERMDOCK_SCHEMA;
}

export function qualified(ctx: RlsSqlContext, name: string): string {
  return `${quoteIdent(helperSchema(ctx))}.${name}`;
}

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

export function membershipTable(name: string): string {
  return quoteTable(name.includes(".") ? name : `public.${name}`);
}

/** `user` is the SQL for the user id: `auth.uid()` (the default) or the `p_user` parameter of a `_for` helper. */
export function signedIn(
  ctx: RlsSqlContext,
  user: string = subjectIdSql(ctx),
): string {
  return `coalesce(${user}::text, '') <> ''`;
}

function activeTenant(ctx: RlsSqlContext): string {
  return `nullif(${subjectClaimSql(ctx, ctx.tenantClaim)}, '')`;
}

function rootName(ctx: RlsSqlContext): string {
  return ctx.scopes[0]?.name ?? "tenant";
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
): string[] {
  return activeInstancesSql(ctx, scope, idOf).map(
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

function hasBody(ctx: RlsSqlContext): string {
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

/** Entries of a compact custom-role claim (`cg.g`) that match `where`. */
function claimEntries(where: string, value: string): string {
  return `array(select ${value} from jsonb_array_elements_text(cg.g) e where ${where})`;
}

/** The stored allow as `permissions` hands it to `permdock_custom_keys`: `key`, or `key@level` with levels. */
function allowEntry(ctx: RlsSqlContext): string {
  return ctx.customRoles?.levels === true
    ? "permission || coalesce('@' || c.level, '')"
    : "permission";
}

function textArray(values: readonly string[]): string {
  return values.length === 0
    ? `'{}'::text[]`
    : `array[${values.map(quoteLiteral).join(", ")}]::text[]`;
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
  const filters = [
    `  where ${memberColumn(table.user)} = ${subjectIdSql(ctx)}`,
  ];
  if (table.expiresAt !== undefined) {
    const expires = memberColumn(table.expiresAt);
    filters.push(`    and (${expires} is null or ${expires} > now())`);
  }
  if (tenantColumn !== undefined) {
    filters.push(
      `    and (${activeTenant(ctx)} is null or ${memberColumn(tenantColumn)}::text = ${activeTenant(ctx)})`,
    );
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
    ),
  );
  const [owner, ...rest] = filters;
  const role = memberRoleOf(table, "m", "  ");
  const kind = kindFilterSql(ctx, role.sql, memberVia(table));
  const lines = [
    `  select${role.lateral ? " distinct" : ""} ${memberColumn(column)}::${type}`,
    `  from ${membershipTable(table.table)} m${role.join}`,
    `  join ${qualified(ctx, "role_permissions")} rp on rp.role = ${role.sql}`,
    owner ?? "",
    "    and rp.grant_key = p_grant",
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
  return [
    ...lines,
    "  union",
    `  select ${memberColumn(column)}::${type}`,
    `  from ${membershipTable(table.table)} m${role.join}`,
    ...filters,
    `    and not (${role.sql} = any(${textArray(custom.declared)}))`,
    customKeysSql(
      ctx,
      scope,
      rows(
        CUSTOM_ROLES.permissions,
        allowEntry(ctx),
        " and c.effect = 'allow'",
      ),
      rows(CUSTOM_ROLES.permissions, "permission", " and c.effect = 'deny'"),
      rows(CUSTOM_ROLES.includes, "include_role", ""),
    ),
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
  const narrow = underRoot(ctx, scope)
    ? `
    and (${activeTenant(ctx)} is null or ${claimTenant(ctx, scope)} = ${activeTenant(ctx)})`
    : "";
  const filters = `    and m ->> 'scope' = ${quoteLiteral(scope)}
    and m ->> 'id' is not null${narrow}
    and case jsonb_typeof(m -> 'expiresAt')
      when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
      else true
    end${[
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
      .join("")}`;
  const declared = `  select (m ->> 'id')::${type}
  from ${membershipRows(ctx)}
  join ${qualified(ctx, "role_permissions")} rp on rp.role = r.role
  where ${signedIn(ctx)}
    and rp.grant_key = p_grant
    and rp.scope = ${quoteLiteral(scope)}${andLine("    ", kindFilterSql(ctx, "r.role", "m ->> 'via'"))}
${filters}`;
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return declared;
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
 * The custom-role objects: the tables (`database` mode), the ceiling view
 * over the `assignable` declared roles, and `permdock_custom_keys`, which
 * resolves one custom role to the grant keys it holds in a scope. A row in
 * the tables can never reach a key outside the view.
 */
function customRolesSql(ctx: RlsSqlContext): string {
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return "";
  }
  const rp = qualified(ctx, "role_permissions");
  const ceiling = qualified(ctx, CUSTOM_ROLES.ceiling);
  const keys = qualified(ctx, CUSTOM_ROLES.keys);
  const chunks: string[] = [];
  if (ctx.authorize === "database") {
    const tenantType = tenantTypeOf(ctx);
    for (const [name, column, check] of [
      [
        CUSTOM_ROLES.permissions,
        "permission",
        `,
  effect text not null default 'allow' check (effect in ('allow', 'deny'))`,
      ],
      [CUSTOM_ROLES.includes, "include_role", ""],
    ] as const) {
      const table = qualified(ctx, name);
      const leveled =
        custom.levels === true && name === CUSTOM_ROLES.permissions;
      const unique = `${column}${name === CUSTOM_ROLES.permissions ? ", effect" : ""}${leveled ? ", coalesce(level, '')" : ""}`;
      const index = leveled
        ? `drop index if exists ${qualified(ctx, quoteIdent(`${name}_key`))};
alter table ${table} add column if not exists level text check (level ~ '^[a-z][a-z0-9_]*$');
create unique index if not exists ${quoteIdent(`${name}_level_key`)}`
        : `create unique index if not exists ${quoteIdent(`${name}_key`)}`;
      chunks.push(`create table if not exists ${table} (
  tenant_id ${tenantType},
  scope text not null default ${quoteLiteral(rootName(ctx))},
  scope_id text,
  role text not null,
  ${column} text not null${check},
  check ((scope = 'global') = (tenant_id is null)),
  check (scope <> 'global' or scope_id is null)
);
${index}
  on ${table} (coalesce(tenant_id::text, ''), scope, coalesce(scope_id, ''), role, ${unique});
alter table ${table} enable row level security;
revoke all on table ${table} from anon, authenticated, public;`);
    }
  }
  chunks.push(`-- the ceiling: keys of assignable declared roles, and the denies of those roles on the same permissions
create or replace view ${ceiling} with (security_invoker = true) as
select rp.scope, rp.role, rp.permission, rp.grant_key, rp.effect
from ${rp} rp
where rp.role = any(${textArray(custom.assignable)})
  and exists (
    select 1 from ${rp} a
    where a.role = rp.role
      and a.permission = rp.permission
      and a.scope = rp.scope
      and a.effect = 'allow'
  );
revoke all on table ${ceiling} from anon, authenticated, public;`);
  const renames = Object.entries(custom.renamed ?? {}).toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (custom.levels === true) {
    chunks.push(leveledKeysSql(ctx, renames));
    return chunks.join("\n\n");
  }
  const rename = renamesSql(renames);
  chunks.push(`-- one custom role: included ceiling keys and same-scope denies, plus every ceiling key of an allowed permission, minus denied permissions
create or replace function ${keys}(p_allow text[], p_deny text[], p_include text[], p_scope text)
returns setof text
language sql
stable
set search_path = ''
as $$
  with ${rename.prelude}ceiling as (
    select c.role, ${rename.permission("c")}, c.grant_key, c.effect
    from ${ceiling} c${rename.join("c")}
    where c.scope = p_scope
  ),
  included as (
    select rp.role, ${rename.permission("rp")}, rp.grant_key, rp.scope, rp.effect
    from ${rp} rp${rename.join("rp")}
    where rp.role = any(coalesce(p_include, '{}'::text[]))
  ),
  kept as (
    select i.permission, i.grant_key
    from included i
    where i.effect = 'allow'
      and i.scope = p_scope
      and exists (
        select 1 from ceiling c
        where c.role = i.role and c.grant_key = i.grant_key and c.effect = 'allow'
      )
  ),
  wanted as (
    ${rename.allow}
    union
    select i.permission
    from included i
    where i.effect = 'allow'
      and not (i.scope = p_scope and exists (
        select 1 from ceiling c
        where c.role = i.role and c.grant_key = i.grant_key and c.effect = 'allow'
      ))
  ),
  allowed as (
    select w.permission
    from wanted w
    where not (${rename.denied("w")})
      and not exists (select 1 from kept k where k.permission = w.permission)
  )
  select k.grant_key from kept k
  where not (${rename.denied("k")})
  union
  select i.grant_key from included i
  where i.effect = 'deny' and i.scope = p_scope
  union
  select c.grant_key from ceiling c
  where c.permission in (select a.permission from allowed a)
$$;
revoke execute on function ${keys}(text[], text[], text[], text) from public, anon, authenticated;`);
  return chunks.join("\n\n");
}

/**
 * `permdock_custom_keys` when resources declare levels. An allow entry is
 * `key` or `key@level`. A level reaches only the ceiling's `<grant key>@<level>`
 * keys, plus the ceiling denies of that permission; a level no ceiling key
 * carries removes the permission, as `resolveCustomRole` drops it with
 * `unknown-level`.
 */
function leveledKeysSql(
  ctx: RlsSqlContext,
  renames: readonly (readonly [string, string])[],
): string {
  const rp = qualified(ctx, "role_permissions");
  const ceiling = qualified(ctx, CUSTOM_ROLES.ceiling);
  const keys = qualified(ctx, CUSTOM_ROLES.keys);
  const renamed = renames.length > 0;
  const prelude = renamed
    ? `renamed (former, key) as (values ${renames
        .map(
          ([former, current]) =>
            `(${quoteLiteral(former)}, ${quoteLiteral(current)})`,
        )
        .join(", ")}),
  `
    : "";
  const current = (raw: string, alias: string): string =>
    renamed ? `coalesce(r_${alias}.key, ${raw})` : raw;
  const join = (raw: string, alias: string): string =>
    renamed
      ? ` left join renamed r_${alias} on r_${alias}.former = ${raw}`
      : "";
  return `-- one custom role: as above, where an allow entry key@level reaches only the ceiling keys of that level
create or replace function ${keys}(p_allow text[], p_deny text[], p_include text[], p_scope text)
returns setof text
language sql
stable
set search_path = ''
as $$
  with ${prelude}entries as (
    select ${current("split_part(e.entry, '@', 1)", "e")} as permission, nullif(split_part(e.entry, '@', 2), '') as level
    from unnest(coalesce(p_allow, '{}'::text[])) as e(entry)${join("split_part(e.entry, '@', 1)", "e")}
  ),
  ceiling as (
    select c.role, ${current("c.permission", "c")} as permission, c.grant_key, c.effect
    from ${ceiling} c${join("c.permission", "c")}
    where c.scope = p_scope
  ),
  levels as (
    select distinct c.permission, split_part(c.grant_key, '@', 2) as level
    from ceiling c
    where c.effect = 'allow' and strpos(c.grant_key, '@') > 0
  ),
  denied as (
    select ${current("d.permission", "d")} as permission
    from unnest(coalesce(p_deny, '{}'::text[])) as d(permission)${join("d.permission", "d")}
    union
    select e.permission from entries e
    where e.level is not null
      and not exists (select 1 from levels l where l.permission = e.permission and l.level = e.level)
  ),
  included as (
    select rp.role, ${current("rp.permission", "rp")} as permission, rp.grant_key, rp.scope, rp.effect
    from ${rp} rp${join("rp.permission", "rp")}
    where rp.role = any(coalesce(p_include, '{}'::text[]))
  ),
  kept as (
    select i.permission, i.grant_key
    from included i
    where i.effect = 'allow'
      and i.scope = p_scope
      and exists (
        select 1 from ceiling c
        where c.role = i.role and c.grant_key = i.grant_key and c.effect = 'allow'
      )
  ),
  wanted as (
    select e.permission from entries e where e.level is null
    union
    select i.permission
    from included i
    where i.effect = 'allow'
      and not (i.scope = p_scope and exists (
        select 1 from ceiling c
        where c.role = i.role and c.grant_key = i.grant_key and c.effect = 'allow'
      ))
  ),
  allowed as (
    select w.permission
    from wanted w
    where w.permission not in (select d.permission from denied d)
      and not exists (select 1 from kept k where k.permission = w.permission)
  ),
  allowed_levels as (
    select e.permission, e.level
    from entries e
    where e.level is not null
      and e.permission not in (select d.permission from denied d)
      and e.permission not in (select a.permission from allowed a)
      and not exists (select 1 from kept k where k.permission = e.permission)
  )
  select k.grant_key from kept k
  where k.permission not in (select d.permission from denied d)
  union
  select i.grant_key from included i
  where i.effect = 'deny' and i.scope = p_scope
  union
  select c.grant_key from ceiling c
  where c.permission in (select a.permission from allowed a)
  union
  select c.grant_key from ceiling c
  join allowed_levels a on a.permission = c.permission
  where c.effect = 'deny' or split_part(c.grant_key, '@', 2) = a.level
$$;
revoke execute on function ${keys}(text[], text[], text[], text) from public, anon, authenticated;`;
}

function currentKeysSql(array: string): string {
  return `select coalesce(r.key, e.permission) as permission
    from unnest(coalesce(${array}, '{}'::text[])) as e(permission)
    left join renamed r on r.former = e.permission`;
}

/**
 * SQL fragments that read a stored former key as its current key inside
 * `permdock_custom_keys`. Without renames they are the plain column and
 * array reads.
 */
function renamesSql(renames: readonly (readonly [string, string])[]): {
  readonly prelude: string;
  readonly permission: (alias: string) => string;
  readonly join: (alias: string) => string;
  readonly allow: string;
  readonly denied: (alias: string) => string;
} {
  if (renames.length === 0) {
    return {
      prelude: "",
      permission: (alias) => `${alias}.permission`,
      join: () => "",
      allow: "select unnest(coalesce(p_allow, '{}'::text[])) as permission",
      denied: (alias) =>
        `${alias}.permission = any(coalesce(p_deny, '{}'::text[]))`,
    };
  }
  const values = renames
    .map(
      ([former, current]) =>
        `(${quoteLiteral(former)}, ${quoteLiteral(current)})`,
    )
    .join(", ");
  return {
    prelude: `renamed (former, key) as (values ${values}),
  denied as (
    ${currentKeysSql("p_deny")}
  ),
  `,
    permission: (alias) =>
      `coalesce(r_${alias}.key, ${alias}.permission) as permission`,
    join: (alias) =>
      ` left join renamed r_${alias} on r_${alias}.former = ${alias}.permission`,
    allow: currentKeysSql("p_allow"),
    denied: (alias) =>
      `${alias}.permission in (select d.permission from denied d)`,
  };
}

/**
 * The rows the membership sources select for the subject, one per instance
 * (`scope`, `id`, `within`, `roles`, `via`), with each source's own expiry
 * and suspension filters: the statements the token hook runs.
 */
function sourceRows(sources: readonly SqlMembershipSource[]): string {
  return sources
    .map((source, index) =>
      source.sql.select(sourceUser(index)).replaceAll(/^/gmu, "    "),
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
type Body = {
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
function functionBody(body: Body): string {
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
): string {
  return [
    ...userActive(ctx, "    ", user),
    ...instancesActive(ctx, scope, sourceIdOf(scope), "    "),
  ]
    .map((line) => `\n${line}`)
    .join("");
}

function sourcesBody(ctx: RlsSqlContext, scope: string, type: string): Body {
  const root = rootName(ctx);
  const tenant = sourceIdOf(scope)(root);
  const narrow = underRoot(ctx, scope)
    ? `\n    and (${activeTenant(ctx)} is null or ${tenant} = ${activeTenant(ctx)})`
    : "";
  const sources = scopeSources(ctx, scope);
  const rows = `  from (
${sourceRows(sources)}
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)`;
  const declared = `  select (ms.id)::${type}
${rows}
  join ${qualified(ctx, "role_permissions")} rp on rp.role = r.role
  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}
    and rp.grant_key = p_grant
    and rp.scope = ${quoteLiteral(scope)}${andLine("    ", kindFilterSql(ctx, "r.role", "ms.via"))}${narrow}${sourceFilters(ctx, scope)}`;
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
  return sourcesBodyOf(
    `${declared}
  union
  select (ms.id)::${type}
${rows}
  where ${signedIn(ctx)}
    and ms.scope = ${quoteLiteral(scope)}
    and not (r.role = any(${textArray(custom.declared)}))${narrow}${sourceFilters(ctx, scope)}
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
    and m ->> 'id' is not null
    and jsonb_typeof(m -> 'roles') = 'array'
    and jsonb_array_length(m -> 'roles') > 0
    and case jsonb_typeof(m -> 'expiresAt')
      when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
      else true
    end${[
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
): Body {
  if (sources.length > 0) {
    return sourcesBodyOf(
      `  select distinct (ms.id)::${type}
  from (
${sourceRows(sources)}
  ) ms
  where ${signedIn(ctx, user)}
    and ms.scope = ${quoteLiteral(scope)}
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0${sourceFilters(ctx, scope, user)}`,
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
  const { table, column } = mapped;
  const role = memberRoleOf(table, "m", "  ");
  const lines = [
    `  select distinct ${memberColumn(column)}::${type}`,
    `  from ${membershipTable(table.table)} m${role.join}`,
    `  where ${memberColumn(table.user)} = ${user}`,
    `    and ${role.through === undefined && !role.lateral ? memberColumn(role.column) : role.sql} is not null`,
  ];
  if (table.expiresAt !== undefined) {
    const expires = memberColumn(table.expiresAt);
    lines.push(`    and (${expires} is null or ${expires} > now())`);
  }
  lines.push(
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
  const grants = anonExecute
    ? `revoke execute on function ${fn}() from public;
grant execute on function ${fn}() to anon, authenticated;`
    : `revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;`;
  return `create or replace function ${fn}()
returns setof ${type}
${functionBody(memberBody(ctx, scope, type))}
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
  chunks.push(
    helperFunction(ctx, HELPERS.has, "boolean", sqlBody(hasBody(ctx)), anon),
  );
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
        scopedBody(ctx, scope.name, type),
        anon,
      ),
    );
    chunks.push(memberFunction(ctx, scope.name, type, anon));
    if (hasMemberFor(ctx, scope.name)) {
      chunks.push(memberForFunction(ctx, scope.name, type));
    }
  }
  return `${chunks.join("\n\n")}\n`;
}
