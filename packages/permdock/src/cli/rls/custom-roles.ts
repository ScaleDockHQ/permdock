import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsCustomRoleTable } from "../types.ts";

import { sqlTextArray } from "../../core/sql.ts";
import { byKey } from "../shared/compare.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import { hasMemberFor, memberIdsHelper } from "../sql/names.ts";
import { qualified, quoteIdent, quoteLiteral } from "../sql/quote.ts";
import { CUSTOM_ROLES, HELPERS, rootName, signedIn } from "../sql/shared.ts";

/** The readers every helpers file ends with. Names are part of the SQL contract. */
const READERS = {
  keys: "permdock_permission_keys",
  roles: "permdock_role_permissions",
  trusted: "permdock_trusted_role_permissions",
} as const;

/**
 * The custom-role objects: the tables (`database` mode), the ceiling view
 * over the `assignable` declared roles, and `permdock_custom_keys`, which
 * resolves one custom role to the grant keys it holds in a scope. A row in
 * the tables can never reach a key outside the view.
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
  on ${table} (coalesce(tenant_id::text, ''), scope, coalesce(scope_id, ''), role, ${unique});
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

/** `permdock_is_shared_role(p_scope, p_role)` (`database` mode): whether a shared custom role of that name exists at the scope. */
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
 * The catalog reader `permdock_permission_keys()` and the role reader
 * `permdock_role_permissions(p_role, p_scope, p_tenant, p_scope_id)`, both
 * for `authenticated`. A declared role answers from `role_permissions`, which
 * is the catalog. A custom role (`database` mode) answers from the tenant's
 * own rows through `permdock_custom_keys`, only to a member of the tenant or
 * a holder of a `meta.manageRoles` permission for a platform role; a shared
 * role (no tenant below global) to any signed-in caller. The
 * effect is `deny` for a deny the role carries after the ceiling, as
 * `resolveCustomRole` returns it, never for a deny that merely removes an allow.
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
    const allowEntryOf =
      custom.levels === true
        ? "c.permission || coalesce('@' || c.level, '')"
        : "c.permission";
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
      : `\ngrant execute on function ${trusted}(${signature}) to ${trustedReaders.map(quoteIdent).join(", ")};`;
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
 * The tenant half of a custom-role row match for a membership: the
 * membership's tenant, or no tenant when a shared role of that name exists at
 * the scope, so a shared role shadows a tenant role of the same name.
 */
export function customTenantMatch(
  ctx: RlsSqlContext,
  tenant: string,
  scope: string,
  role: string,
): string {
  return `case when ${qualified(ctx, CUSTOM_ROLES.shared)}(${quoteLiteral(scope)}, ${role}) then c.tenant_id is null else c.tenant_id::text = ${tenant} end`;
}

/**
 * The scope of a row of the application's roles table: its scope column (or
 * the first scope) with a tenant; with no tenant, the same scope when the
 * `shared` column is true, else `'global'`.
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

/** `expr` read as its current key: a former key maps to the key it was renamed to. */
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

/** `case p_scope when '<scope>' then <sql for scope> ... else false end` over the declared scopes. */
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
  errcode: "22023" | "42501",
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
