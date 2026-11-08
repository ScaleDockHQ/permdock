import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsCustomRoleTable } from "../types.ts";

import { sqlTextArray } from "../../core/sql.ts";
import { byKey } from "../shared/compare.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import { hasMemberFor, memberIdsHelper } from "../sql/names.ts";
import {
  helperSchema,
  qualified,
  quoteIdent,
  quoteLiteral,
} from "../sql/quote.ts";
import {
  CUSTOM_ROLES,
  HELPERS,
  allowEntry,
  rootName,
  signedIn,
} from "../sql/shared.ts";

/** The readers every helpers file ends with. Names are part of the SQL contract. */
const READERS = {
  keys: "permdock_permission_keys",
  roles: "permdock_role_permissions",
  trusted: "permdock_trusted_role_permissions",
} as const;

/**
 * The custom-role objects: the tables (`database` mode), the ceiling view over
 * the `assignable` declared roles, and `permdock_custom_keys`, which resolves
 * one custom role to the grant keys it holds in a scope. A row in the tables
 * can never reach a key outside the view.
 */
export function customRolesSql(ctx: RlsSqlContext): string {
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
      // `nulls not distinct` (Postgres 15) makes a null tenant, instance or level one
      // key, which the old `coalesce(...)` expression index spelled out.
      const unique = `tenant_id, scope, scope_id, role, ${column}${name === CUSTOM_ROLES.permissions ? ", effect" : ""}${leveled ? ", level" : ""}`;
      // A declarative file holds no drop: pg-delta drops the old `${name}_key` index
      // itself, and a migration project drops it once.
      const index = `${leveled ? `alter table ${table} add column if not exists level text check (level ~ '^[a-z][a-z0-9_]*$');\n` : ""}create unique index if not exists ${quoteIdent(`${name}_nnd_key`)}`;
      chunks.push(`create table if not exists ${table} (
  tenant_id ${tenantType},
  scope text not null default ${quoteLiteral(rootName(ctx))},
  scope_id text,
  role text not null,
  ${column} text not null${check}
);
-- global: no tenant or instance; a tenant role: a tenant; a shared role: no tenant or instance
alter table ${table} drop constraint if exists ${quoteIdent(`${name}_check`)};
alter table ${table} drop constraint if exists ${quoteIdent(`${name}_shape`)};
alter table ${table} add constraint ${quoteIdent(`${name}_shape`)} check (
  case when scope = 'global' then tenant_id is null and scope_id is null
  else tenant_id is not null or scope_id is null end
);
${index}
  on ${table} (${unique}) nulls not distinct;
-- the probe's equality columns lead, so one range scan reads a role's rows whatever its instance pin
create index if not exists ${quoteIdent(`${name}_probe_idx`)}
  on ${table} (tenant_id, scope, role) include (scope_id, ${column}${name === CUSTOM_ROLES.permissions ? ", effect" : ""}${leveled ? ", level" : ""});
-- a row identity for triggers the application adds, such as an audit trigger that reads the primary key
alter table ${table} add column if not exists id bigint generated always as identity primary key;
alter table ${table} enable row level security;
revoke all on table ${table} from anon, authenticated, public;`);
    }
  }
  chunks.push(`-- the ceiling: keys of assignable declared roles, and the denies of those roles on the same permissions
create or replace view ${ceiling} with (security_invoker = true) as
select rp.scope, rp.role, rp.permission, rp.grant_key, rp.effect
from ${rp} rp
where rp.role = any(${sqlTextArray(custom.assignable)})
  and exists (
    select 1 from ${rp} a
    where a.role = rp.role
      and a.permission = rp.permission
      and a.scope = rp.scope
      and a.effect = 'allow'
  );
revoke all on table ${ceiling} from anon, authenticated, public;`);
  const renames = Object.entries(custom.renamed ?? {}).toSorted(byKey);
  const shared = sharedRoleSql(ctx);
  if (custom.levels === true) {
    chunks.push(leveledKeysSql(ctx, renames));
    if (shared !== "") {
      chunks.push(shared);
    }
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
  if (shared !== "") {
    chunks.push(shared);
  }
  return chunks.join("\n\n");
}

/**
 * `permdock_is_shared_role(p_scope, p_role)` (`database` mode): whether a
 * shared custom role of that name exists at the scope.
 */
function sharedRoleSql(ctx: RlsSqlContext): string {
  if (ctx.authorize !== "database") {
    return "";
  }
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const shared = qualified(ctx, CUSTOM_ROLES.shared);
  return `-- a shared custom role: rows with no tenant at a scope below global; its name wins over a tenant role's in every tenant
create or replace function ${shared}(p_scope text, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_scope <> 'global' and (
    exists (select 1 from ${perms} c where c.tenant_id is null and c.scope = p_scope and c.role = p_role)
    or exists (select 1 from ${includes} c where c.tenant_id is null and c.scope = p_scope and c.role = p_role)
  )
$$;
revoke execute on function ${shared}(text, text) from public, anon, authenticated;`;
}

/**
 * `permdock_custom_keys` when resources declare levels. An allow entry is `key`
 * or `key@level`. A level reaches the ceiling's `<grant key>@<level>` keys,
 * plus every narrower level when the resource sets `orderedLevels`, and the
 * ceiling denies of that permission. A level no ceiling key carries removes the
 * permission, as `resolveCustomRole` drops it with `unknown-level`.
 */
function leveledKeysSql(
  ctx: RlsSqlContext,
  renames: readonly (readonly [string, string])[],
): string {
  const rp = qualified(ctx, "role_permissions");
  const ceiling = qualified(ctx, CUSTOM_ROLES.ceiling);
  const keys = qualified(ctx, CUSTOM_ROLES.keys);
  const order = ctx.customRoles?.levelOrder ?? [];
  const orderCte =
    order.length === 0
      ? ""
      : `level_order (permission, level, ord) as (values ${order
          .map(
            ([permission, level, ord]) =>
              `(${quoteLiteral(permission)}, ${quoteLiteral(level)}, ${String(ord)})`,
          )
          .join(", ")}),
  `;
  const covered =
    order.length === 0
      ? ""
      : `
    or exists (
      select 1
      from level_order held
      join level_order asked on asked.permission = held.permission and asked.ord <= held.ord
      where held.permission = a.permission
        and held.level = a.level
        and asked.level = split_part(c.grant_key, '@', 2)
    )`;
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
  return `-- one custom role: as above, where an allow entry key@level reaches the ceiling keys of that level and, when ordered, every narrower level
create or replace function ${keys}(p_allow text[], p_deny text[], p_include text[], p_scope text)
returns setof text
language sql
stable
set search_path = ''
as $$
  with ${prelude}${orderCte}entries as (
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
  where c.effect = 'deny' or split_part(c.grant_key, '@', 2) = a.level${covered}
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
 * `permdock_custom_keys`. Without renames they are the plain column and array
 * reads.
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
 * The catalog reader `permdock_permission_keys()` and the role reader
 * `permdock_role_permissions(p_role, p_scope, p_tenant, p_scope_id)`, both for
 * `authenticated`. A declared role answers from `role_permissions`, which is
 * the catalog. A custom role (`database` mode) answers from the tenant's own
 * rows through `permdock_custom_keys`, only to a member of the tenant or a
 * holder of a `meta.manageRoles` permission for a platform role; a shared role
 * (no tenant below global) to any signed-in caller. The effect is `deny` for a
 * deny the role carries after the ceiling, as `resolveCustomRole` returns it,
 * never for a deny that merely removes an allow.
 */
export function roleReadersSql(
  ctx: RlsSqlContext,
  permissions: readonly string[] | undefined,
  trustedReaders: readonly string[] | undefined,
): string {
  const rp = qualified(ctx, "role_permissions");
  const reader = qualified(ctx, READERS.roles);
  const tenantType = tenantTypeOf(ctx);
  const custom = ctx.customRoles;
  const root = ctx.scopes[0]?.name;
  const database = ctx.authorize === "database";
  const chunks: string[] = [];
  if (permissions !== undefined) {
    const catalog = qualified(ctx, READERS.keys);
    chunks.push(`-- every declared permission key
create or replace function ${catalog}()
returns setof text
language sql
stable
set search_path = ''
as $$
  select k.permission from unnest(${sqlTextArray(permissions.toSorted())}) k(permission) order by 1
$$;
revoke execute on function ${catalog}() from public, anon;
grant execute on function ${catalog}() to authenticated;

create or replace function ${catalog}(p_scope text)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select distinct rp.permission
  from ${rp} rp
  where rp.scope = p_scope
    and rp.effect = 'allow'
    and rp.permission = any(${sqlTextArray(permissions.toSorted())})
  order by 1
$$;
revoke execute on function ${catalog}(text) from public, anon;
grant execute on function ${catalog}(text) to authenticated;`);
  }
  const declared = `  select distinct rp.permission, rp.effect
  from ${rp} rp
  where rp.role = p_role and rp.scope = p_scope
  order by 1, 2`;
  let body = `begin
  perform p_tenant, p_scope_id; -- only a custom role reads them
  return query
${declared};
end;`;
  let trustedBody = body;
  if (custom !== undefined && database && root !== undefined) {
    const tenant = qualified(ctx, CUSTOM_ROLES.permissions);
    const includes = qualified(ctx, CUSTOM_ROLES.includes);
    const keys = qualified(ctx, CUSTOM_ROLES.keys);
    const shape = qualified(ctx, CUSTOM_ROLES.shape);
    const ids = (helper: string): string =>
      `(select x::text from ${qualified(ctx, helper)}() x)`;
    const memberOf = `p_tenant::text in ${ids(memberIdsHelper(root))}
      or ${perScope(ctx, (scope) => (scope === root ? "false" : `p_scope_id in ${ids(memberIdsHelper(scope))}`))}`;
    const manage = custom.manage ?? [];
    const platform =
      manage.length === 0
        ? "false"
        : `exists (
        select 1 from ${rp} m
        where m.effect = 'allow'
          and m.permission = any(${sqlTextArray(manage)})
          and ${qualified(ctx, HELPERS.has)}(m.grant_key)
      )`;
    const match = `c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role`;
    const allowEntryOf = `c.${allowEntry(ctx)}`;
    const checked = (gate: string): string => `begin
  if p_role = any(${sqlTextArray(custom.declared)}) then
    return query
${declared};
    return;
  end if;
  perform ${shape}(p_tenant, p_scope, p_scope_id, p_role);${gate}
  return query
  select distinct rp.permission, rp.effect
  from ${keys}(
    array(select ${allowEntryOf} from ${tenant} c where ${match} and c.effect = 'allow'),
    array(select c.permission from ${tenant} c where ${match} and c.effect = 'deny'),
    array(select c.include_role from ${includes} c where ${match}),
    p_scope
  ) k(grant_key)
  join ${rp} rp on rp.grant_key = k.grant_key and rp.scope = p_scope
  order by 1, 2;
end;`;
    body = checked(`
  if not (${signedIn(ctx)} and (
    ${platform}
    or (p_scope <> 'global' and p_tenant is null and p_scope_id is null)
    or (p_scope <> 'global' and (${memberOf}))
  )) then
${raiseSql("    ", "42501", `'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform')`, "not-member")}
  end if;`);
    trustedBody = checked("");
  }
  chunks.push(`-- the permission keys a role holds on a scope, with effect allow or deny; a custom role is read for its tenant and, below the first scope, its instance
create or replace function ${reader}(p_role text, p_scope text, p_tenant ${tenantType} default null, p_scope_id text default null)
returns table (permission text, effect text)
language plpgsql
stable
security definer
set search_path = ''
as $$
${body}
$$;
revoke execute on function ${reader}(text, text, ${tenantType}, text) from public, anon;
grant execute on function ${reader}(text, text, ${tenantType}, text) to authenticated;`);
  const trusted = qualified(ctx, READERS.trusted);
  const signature = `text, text, ${tenantType}, text`;
  const grants =
    trustedReaders === undefined || trustedReaders.length === 0
      ? ""
      : `\n${trustedReaderGrants(ctx, `${trusted}(${signature})`, trustedReaders)}`;
  chunks.push(`create or replace function ${trusted}(p_role text, p_scope text, p_tenant ${tenantType} default null, p_scope_id text default null)
returns table (permission text, effect text)
language plpgsql
stable
security definer
set search_path = ''
as $$
${trustedBody}
$$;
revoke execute on function ${trusted}(${signature}) from public, anon, authenticated;${grants}`);
  return chunks.join("\n\n");
}

/**
 * The stored definition of `p_role` at `p_scope` for `p_tenant`: the shared
 * rows when a shared role has the name.
 */
export function storedTenant(ctx: RlsSqlContext): string {
  return `case when ${qualified(ctx, CUSTOM_ROLES.shared)}(p_scope, p_role) then c.tenant_id is null else c.tenant_id is not distinct from p_tenant end`;
}

type CustomRoleProbe = {
  readonly scope: string;
  readonly role: string;
  /**
   * A SQL expression of the tenant column's type, so the column is compared
   * uncast and the unique index applies; `undefined` for a platform role.
   */
  readonly tenant: string | undefined;
  /**
   * A SQL text for the instance a role may be pinned to; `undefined` for a
   * platform role.
   */
  readonly instance: string | undefined;
};

/**
 * One probe of one custom role: its allow entries, its deny entries and the
 * roles it includes, as three sorted arrays in one row. One probe of
 * `custom_role_permissions` serves the allows and the denies, and one
 * `permdock_is_shared_role()` call per membership replaces the three the array
 * subselects made. A platform role (`tenant` undefined) has no tenant.
 */
export function customArraysQuery(
  ctx: RlsSqlContext,
  input: CustomRoleProbe,
): string {
  const scope = quoteLiteral(input.scope);
  const tenantMatch = (alias: string): string =>
    input.tenant === undefined
      ? `${alias}.tenant_id is null`
      : `(not pdk_s.shared and ${alias}.tenant_id = ${input.tenant} or pdk_s.shared and ${alias}.tenant_id is null)`;
  const match = (alias: string): string =>
    [
      tenantMatch(alias),
      `${alias}.scope = ${scope}`,
      input.instance === undefined
        ? `${alias}.scope_id is null`
        : `(${alias}.scope_id is null or ${alias}.scope_id = ${input.instance})`,
      `${alias}.role = ${input.role}`,
    ].join(" and ");
  const shared =
    input.tenant === undefined
      ? "(select false as shared)"
      : `(select ${qualified(ctx, CUSTOM_ROLES.shared)}(${scope}, ${input.role}) as shared offset 0)`;
  const entry = `c.${allowEntry(ctx)}`;
  return `select p.allow, p.deny, i.incl
        from ${shared} pdk_s
        cross join lateral (
          select array(select i.include_role from ${qualified(ctx, CUSTOM_ROLES.includes)} i where ${match("i")} order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(${entry} order by ${entry}) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from ${qualified(ctx, CUSTOM_ROLES.permissions)} c
          where ${match("c")}
        ) p`;
}

/**
 * The grant keys one custom role holds, as a `select` of `grant_key`, for a
 * caller that asks per membership.
 */
export function customKeysQuery(
  ctx: RlsSqlContext,
  input: CustomRoleProbe,
): string {
  return `select k.grant_key
      from (${customArraysQuery(ctx, input)}) pdk_e
      cross join lateral ${qualified(ctx, CUSTOM_ROLES.keys)}(pdk_e.allow, pdk_e.deny, pdk_e.incl, ${quoteLiteral(input.scope)}) k(grant_key)`;
}

/**
 * The scope of a row of the application's roles table: its scope column (or the
 * first scope) with a tenant; with no tenant, the same scope when the `shared`
 * column is true, else `'global'`.
 */
export function rolesTableScope(
  table: RlsCustomRoleTable,
  tenant: string,
  root: string,
  column: (name: string) => string,
): string {
  const own =
    table.scope === undefined
      ? quoteLiteral(root)
      : `${column(table.scope)}::text`;
  const none =
    table.shared === undefined
      ? "'global'"
      : `case when coalesce(${column(table.shared)}, false) then ${own} else 'global' end`;
  return `case when ${tenant} is null then ${none} else ${own} end`;
}

/**
 * `expr` read as its current key: a former key maps to the key it was renamed
 * to.
 */
export function currentKeyExpr(
  renames: readonly (readonly [string, string])[],
  expr: string,
): string {
  if (renames.length === 0) {
    return expr;
  }
  const arms = renames
    .map(
      ([former, current]) =>
        `when ${quoteLiteral(former)} then ${quoteLiteral(current)}`,
    )
    .join(" ");
  return `(case ${expr} ${arms} else ${expr} end)`;
}

/**
 * `case p_scope when '<scope>' then <sql for scope> ... else false end` over
 * the declared scopes.
 */
export function perScope(
  ctx: RlsSqlContext,
  sql: (scope: string) => string,
): string {
  const arms = ctx.scopes
    .map((scope) => `when ${quoteLiteral(scope.name)} then ${sql(scope.name)}`)
    .join(" ");
  return arms === "" ? "false" : `(case p_scope ${arms} else false end)`;
}

export function raiseSql(
  indent: string,
  errcode: "22023" | "42501" | "P0002",
  message: string,
  hint: string,
): string {
  return `${indent}raise exception using
${indent}  errcode = '${errcode}',
${indent}  message = ${message},
${indent}  hint = ${quoteLiteral(hint)};`;
}

export function hasCustomRoleChecksFor(ctx: RlsSqlContext): boolean {
  return (
    ctx.authorize === "database" &&
    ctx.customRoles !== undefined &&
    ctx.scopes.length > 0 &&
    ctx.scopes.every((scope) => hasMemberFor(ctx, scope.name))
  );
}

/**
 * The grants a `rls.trustedReaders` role needs for one reader: usage on the
 * helper schema, which no client role reaches through these lines, and execute
 * on the function.
 */
export function trustedReaderGrants(
  ctx: RlsSqlContext,
  fn: string,
  readers: readonly string[],
): string {
  const to = readers.map(quoteIdent).join(", ");
  return `grant usage on schema ${quoteIdent(helperSchema(ctx))} to ${to};
grant execute on function ${fn} to ${to};`;
}
