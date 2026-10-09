import type { RlsSqlContext } from "./rls-sql.ts";

import {
  allowEntry,
  CUSTOM_ROLES,
  HELPERS,
  qualified,
  rootName,
  signedIn,
  textArray,
} from "./rls-shared.ts";
import {
  hasMemberFor,
  memberForHelper,
  memberIdsHelper,
  permittedForHelper,
  permittedIdsHelper,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  subjectIdSql,
  tenantTypeOf,
} from "./rls-sql.ts";

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
 * The catalog reader `permdock_permission_keys()` and the role reader
 * `permdock_role_permissions(p_role, p_scope, p_tenant, p_scope_id)`, both
 * for `authenticated`. A declared role answers from `role_permissions`, which
 * is the catalog. A custom role (`database` mode) answers from the tenant's
 * own rows through `permdock_custom_keys`, only to a member of the tenant or
 * a holder of a `meta.manageRoles` permission for a platform role. The
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
  select k.permission from unnest(${textArray(permissions.toSorted())}) k(permission) order by 1
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
    and rp.permission = any(${textArray(permissions.toSorted())})
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
          and m.permission = any(${textArray(manage)})
          and ${qualified(ctx, HELPERS.has)}(m.grant_key)
      )`;
    const match = `c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role`;
    const allowEntryOf =
      custom.levels === true
        ? "c.permission || coalesce('@' || c.level, '')"
        : "c.permission";
    const checked = (gate: string): string => `begin
  if p_role = any(${textArray(custom.declared)}) then
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

/** `expr` read as its current key: a former key maps to the key it was renamed to. */
function currentKeyExpr(
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
function perScope(ctx: RlsSqlContext, sql: (scope: string) => string): string {
  const arms = ctx.scopes
    .map((scope) => `when ${quoteLiteral(scope.name)} then ${sql(scope.name)}`)
    .join(" ");
  return arms === "" ? "false" : `(case p_scope ${arms} else false end)`;
}

function raiseSql(
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

function callerFunctionsSql(
  ctx: RlsSqlContext,
  custom: NonNullable<RlsSqlContext["customRoles"]>,
  root: string,
  levelReach: readonly (readonly [string, string])[],
  forUser: boolean,
): { readonly beyond: string; readonly guard: string } {
  const leveled = custom.levels === true;
  const tenantType = tenantTypeOf(ctx);
  const rp = qualified(ctx, "role_permissions");
  const keys = qualified(ctx, CUSTOM_ROLES.keys);
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const shape = qualified(ctx, CUSTOM_ROLES.shape);
  const beyond = qualified(
    ctx,
    forUser ? CUSTOM_ROLES.beyondFor : CUSTOM_ROLES.beyond,
  );
  const guard = qualified(
    ctx,
    forUser ? CUSTOM_ROLES.guardFor : CUSTOM_ROLES.guard,
  );
  const user = forUser ? "p_user" : subjectIdSql(ctx);
  const userParam = forUser ? "p_user uuid, " : "";
  const userArg = forUser ? "uuid, " : "";
  const userCall = forUser ? "p_user, " : "";
  const has = (key: string): string =>
    forUser
      ? `${qualified(ctx, HELPERS.hasFor)}(p_user, ${key})`
      : `${qualified(ctx, HELPERS.has)}(${key})`;
  const ids = (helper: string, arg: string): string =>
    `(select x::text from ${qualified(ctx, helper)}(${arg}) x)`;
  const permitted = (scope: string, key: string): string =>
    forUser
      ? ids(permittedForHelper(scope), `p_user, ${key}`)
      : ids(permittedIdsHelper(scope), key);
  const members = (scope: string): string =>
    forUser
      ? ids(memberForHelper(scope), "p_user")
      : ids(memberIdsHelper(scope), "");
  const heldKey = (key: string): string =>
    `(${has(key)}
        or (p_scope <> 'global'
          and (p_tenant::text in ${permitted(root, key)}
            or ${perScope(ctx, (scope) => (scope === root ? "false" : `p_scope_id in ${permitted(scope, key)}`))})))`;
  const holdsAny = (
    permissions: readonly string[],
    held: (key: string) => string,
  ): string =>
    permissions.length === 0
      ? "false"
      : `exists (
    select 1 from ${rp} rp
    where rp.effect = 'allow'
      and rp.permission = any(${textArray(permissions)})
      and ${held("rp.grant_key")}
  )`;
  const manageKeys = custom.manage ?? [];
  const manage = holdsAny(manageKeys, heldKey);
  const platform = holdsAny(manageKeys, has);
  const requires =
    custom.requires === undefined
      ? ""
      : `
  if not ${holdsAny(custom.requires, heldKey)} then
${raiseSql("    ", "42501", `'permdock: the caller may not manage roles in ' || coalesce(p_tenant::text, 'the platform')`, "manage-roles")}
  end if;`;
  const reachRows = levelReach
    .map(
      ([grantKey, level]) =>
        `(${quoteLiteral(grantKey)}, ${quoteLiteral(level)})`,
    )
    .join(", ");
  const levelCheck =
    leveled && reachRows !== ""
      ? `
      or exists (
        select 1
        from reach x
        where x.grant_key = r.grant_key
          and not exists (
            select 1 from held h
            join reach o on o.grant_key = h.grant_key
            where h.permission = r.permission and o.level = x.level
          )
      )`
      : "";
  const reachCte =
    leveled && reachRows !== ""
      ? `,
    reach (grant_key, level) as (values ${reachRows})`
      : "";
  const match = `c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id`;
  const memberOf = `p_tenant::text in ${members(root)}
      or ${perScope(ctx, (scope) => (scope === root ? "false" : `p_scope_id in ${members(scope)}`))}`;
  return {
    beyond: `-- custom-role writes: the permission keys of a definition the caller may not hand out in the tenant, as assignablePermissions computes them
create or replace function ${beyond}(${userParam}p_tenant ${tenantType}, p_scope text, p_scope_id text, p_allow text[], p_deny text[], p_include text[])
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if ${manage} then
    return;
  end if;
  return query
  with resolved as (
    select distinct rp.permission, k.key as grant_key
    from ${keys}(p_allow, p_deny, p_include, p_scope) k(key)
    join ${rp} rp on rp.grant_key = k.key and rp.effect = 'allow'
  ),
  held as (
    select distinct rp.permission, rp.grant_key
    from ${rp} rp
    where rp.effect = 'allow'
      and rp.permission in (select r.permission from resolved r)
      and ${heldKey("rp.grant_key")}
  )${reachCte}
  select distinct r.permission
  from resolved r
  where not exists (select 1 from held h where h.permission = r.permission)${levelCheck};
end;
$$;
revoke execute on function ${beyond}(${userArg}${tenantType}, text, text, text[], text[], text[]) from public, anon, authenticated;`,
    guard: `-- a custom role the caller may change: membership of the tenant or the instance (a platform role, or a caller holding a manageRoles permission through a global role, needs none), and authority over the stored definition
create or replace function ${guard}(${userParam}p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_beyond text;
begin
  perform ${shape}(p_tenant, p_scope, p_scope_id, p_role);
  if not (${signedIn(ctx, user)} and (
    ${platform}
    or (p_scope <> 'global' and (${memberOf}))
  )) then
${raiseSql("    ", "42501", `'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform')`, "not-member")}
  end if;${requires}
  select array_agg(${allowEntry(ctx)}) filter (where c.effect = 'allow'),
    array_agg(c.permission) filter (where c.effect = 'deny')
  into v_allow, v_deny
  from ${perms} c
  where ${match} and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from ${includes} c
  where ${match} and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from ${beyond}(${userCall}p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
${raiseSql("    ", "42501", `'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out'`, "not-assignable-by")}
  end if;
end;
$$;
revoke execute on function ${guard}(${userArg}${tenantType}, text, text, text) from public, anon, authenticated;`,
  };
}

/**
 * The functions an application calls to save, rename and delete a custom
 * role in \`database\` mode, with the rules of \`validateCustomRole\` and
 * \`assignablePermissions\`: entries inside the ceiling of the role's scope,
 * includes naming declared roles, and only permissions and levels the caller
 * may hand out, for the new definition and the stored one alike. A platform
 * custom role (\`p_scope = 'global'\`, no tenant) is written by a caller who
 * holds a \`meta.manageRoles\` permission through a global role. The
 * \`permdock_trusted_*\` variants skip the caller checks and keep the
 * definition checks; no client role may execute them.
 */
export function customRoleWritesSql(
  ctx: RlsSqlContext,
  levelReach: readonly (readonly [string, string])[],
): string {
  const custom = ctx.customRoles;
  const root = ctx.scopes[0]?.name;
  if (
    custom === undefined ||
    ctx.authorize !== "database" ||
    root === undefined
  ) {
    return "";
  }
  const leveled = custom.levels === true;
  const tenantType = tenantTypeOf(ctx);
  const rp = qualified(ctx, "role_permissions");
  const ceiling = qualified(ctx, CUSTOM_ROLES.ceiling);
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const beyond = qualified(ctx, CUSTOM_ROLES.beyond);
  const guard = qualified(ctx, CUSTOM_ROLES.guard);
  const shape = qualified(ctx, CUSTOM_ROLES.shape);
  const entries = qualified(ctx, CUSTOM_ROLES.entries);
  const renames = Object.entries(custom.renamed ?? {}).toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const current = (expr: string): string => currentKeyExpr(renames, expr);
  const known = textArray([
    ...(custom.permissions ?? []),
    ...renames.map(([former]) => former),
  ]);
  const caller = callerFunctionsSql(ctx, custom, root, levelReach, false);
  const match = `c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id`;
  const scopes = textArray(ctx.scopes.map((scope) => scope.name));
  const roleName = (param: string): string =>
    `coalesce(${param}, '') = '' or ${param} = any(${textArray(custom.declared)})`;
  const levelOf = leveled ? ", nullif(split_part(e, '@', 2), '')" : "";
  const levelColumn = leveled ? ", level" : "";
  const write = `  delete from ${perms} c where ${match} and c.role = p_role;
  delete from ${includes} c where ${match} and c.role = p_role;
  insert into ${perms} (tenant_id, scope, scope_id, role, permission, effect${levelColumn})
  select distinct p_tenant, p_scope, p_scope_id, p_role, ${current(leveled ? "split_part(e, '@', 1)" : "e")}, 'allow'${levelOf}
  from unnest(coalesce(p_allow, '{}'::text[])) e
  union
  select distinct p_tenant, p_scope, p_scope_id, p_role, ${current("e")}, 'deny'${leveled ? ", null" : ""}
  from unnest(coalesce(p_deny, '{}'::text[])) e;
  insert into ${includes} (tenant_id, scope, scope_id, role, include_role)
  select distinct p_tenant, p_scope, p_scope_id, p_role, e
  from unnest(coalesce(p_include, '{}'::text[])) e;`;
  const move = `  if ${roleName("p_to")} then
${raiseSql("    ", "22023", `'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name'`, "declared-role")}
  end if;
  if exists (select 1 from ${perms} c where ${match} and c.role = p_to)
    or exists (select 1 from ${includes} c where ${match} and c.role = p_to) then
${raiseSql("    ", "22023", `'permdock: ' || p_to || ' already has grants'`, "role-exists")}
  end if;
  update ${perms} c set role = p_to where ${match} and c.role = p_from;
  update ${includes} c set role = p_to where ${match} and c.role = p_from;`;
  const remove = `  delete from ${perms} c where ${match} and c.role = p_role;
  delete from ${includes} c where ${match} and c.role = p_role;`;
  const writeArgs = `${tenantType}, text, text, text, text[], text[], text[]`;
  const renameArgs = `${tenantType}, text, text, text, text`;
  const removeArgs = `${tenantType}, text, text, text`;
  const fn = (
    comment: string,
    name: string,
    params: string,
    args: string,
    body: string,
    member: boolean,
  ): string => `-- ${comment}
create or replace function ${qualified(ctx, name)}(${params})
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
${body}
$$;
${
  member
    ? `revoke execute on function ${qualified(ctx, name)}(${args}) from public, anon;
grant execute on function ${qualified(ctx, name)}(${args}) to authenticated;`
    : `revoke execute on function ${qualified(ctx, name)}(${args}) from public, anon, authenticated;`
}`;
  const writeParams = `p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text, p_allow text[], p_deny text[], p_include text[]`;
  const renameParams = `p_tenant ${tenantType}, p_scope text, p_scope_id text, p_from text, p_to text`;
  const removeParams = `p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text`;
  return `${caller.beyond}

-- where a custom role may live: a scope of a tenant, or the platform (scope global, no tenant or instance), under an undeclared name
create or replace function ${shape}(p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_scope = 'global' then
    if p_tenant is not null or p_scope_id is not null then
${raiseSql("      ", "22023", `'permdock: a platform custom role has no tenant or instance'`, "unknown-scope")}
    end if;
  elsif p_tenant is null or not (p_scope = any(${scopes})) then
${raiseSql("    ", "22023", `'permdock: custom roles are held at a scope of a tenant or at global, not ' || coalesce(p_scope, 'null')`, "unknown-scope")}
  end if;
  if ${roleName("p_role")} then
${raiseSql("    ", "22023", `'permdock: ' || coalesce(p_role, 'null') || ' is not a custom role name'`, "declared-role")}
  end if;
end;
$$;
revoke execute on function ${shape}(${tenantType}, text, text, text) from public, anon, authenticated;

${caller.guard}
${
  hasCustomRoleChecksFor(ctx)
    ? `
-- the same checks for a user the caller names: trusted SQL acting later for a stored user; no client role may execute them
${callerFunctionsSql(ctx, custom, root, levelReach, true).beyond}

${callerFunctionsSql(ctx, custom, root, levelReach, true).guard}
`
    : ""
}
-- the entries of a definition: declared keys and levels inside the ceiling of the scope, and declared includes
create or replace function ${entries}(p_scope text, p_allow text[], p_deny text[], p_include text[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_entry text;
  v_key text;
begin
  foreach v_entry in array coalesce(p_allow, '{}'::text[]) loop
    v_key := ${current(leveled ? "split_part(v_entry, '@', 1)" : "v_entry")};
    if not (v_key = any(${known})) then
${raiseSql("      ", "22023", `'permdock: ' || v_entry || ' is not a declared permission'`, "unknown-permission")}
    end if;
    if not exists (
      select 1 from ${ceiling} c
      where c.scope = p_scope and c.effect = 'allow' and ${current("c.permission")} = v_key
    ) then
${raiseSql("      ", "22023", `'permdock: ' || v_key || ' is outside the ceiling of ' || p_scope`, "outside-ceiling")}
    end if;${
      leveled
        ? `
    if strpos(v_entry, '@') > 0 and not exists (
      select 1 from ${ceiling} c
      where c.scope = p_scope and c.effect = 'allow' and ${current("c.permission")} = v_key
        and split_part(c.grant_key, '@', 2) = split_part(v_entry, '@', 2)
    ) then
${raiseSql("      ", "22023", `'permdock: ' || v_entry || ' names a level the resource does not declare'`, "unknown-level")}
    end if;`
        : ""
    }
  end loop;
  foreach v_entry in array coalesce(p_deny, '{}'::text[]) loop
    if not (v_entry = any(${known})) then
${raiseSql("      ", "22023", `'permdock: ' || v_entry || ' is not a declared permission'`, "unknown-permission")}
    end if;
  end loop;
  foreach v_entry in array coalesce(p_include, '{}'::text[]) loop
    if not (v_entry = any(${textArray(custom.declared)})) then
${raiseSql("      ", "22023", `'permdock: ' || v_entry || ' is not a declared role'`, "unknown-role")}
    end if;
  end loop;
  select string_agg(distinct ${current("rp.permission")}, ', ') into v_key
  from ${rp} rp
  where rp.role = any(coalesce(p_include, '{}'::text[]))
    and rp.effect = 'allow'
    and not exists (
      select 1 from ${ceiling} c
      where c.scope = p_scope and c.effect = 'allow' and ${current("c.permission")} = ${current("rp.permission")}
    );
  if v_key is not null then
${raiseSql("    ", "22023", `'permdock: an included role allows ' || v_key || ', outside the ceiling of ' || p_scope`, "outside-ceiling")}
  end if;
end;
$$;
revoke execute on function ${entries}(text, text[], text[], text[]) from public, anon, authenticated;

${fn(
  "save a custom role: replace its grants and includes after checking each entry against the ceiling and the caller's own permissions",
  CUSTOM_ROLES.replace,
  writeParams,
  writeArgs,
  `declare
  v_beyond text;
begin
  perform ${guard}(p_tenant, p_scope, p_scope_id, p_role);
  perform ${entries}(p_scope, p_allow, p_deny, p_include);
  select string_agg(b, ', ' order by b) into v_beyond
  from ${beyond}(p_tenant, p_scope, p_scope_id, p_allow, p_deny, p_include) b;
  if v_beyond is not null then
${raiseSql("    ", "42501", `'permdock: ' || p_role || ' would allow ' || v_beyond || ', which the caller may not hand out'`, "not-assignable-by")}
  end if;
${write}
end;`,
  true,
)}

${fn(
  "rename a custom role: move its grants and includes to the new name",
  CUSTOM_ROLES.rename,
  renameParams,
  renameArgs,
  `begin
  perform ${guard}(p_tenant, p_scope, p_scope_id, p_from);
${move}
end;`,
  true,
)}

${fn(
  "delete a custom role: remove its grants and includes",
  CUSTOM_ROLES.remove,
  removeParams,
  removeArgs,
  `begin
  perform ${guard}(p_tenant, p_scope, p_scope_id, p_role);
${remove}
end;`,
  true,
)}

${fn(
  "save a custom role for a trusted caller (a migration, a job, a backend role granted execute): the definition checks without the caller checks",
  CUSTOM_ROLES.trustedReplace,
  writeParams,
  writeArgs,
  `begin
  perform ${shape}(p_tenant, p_scope, p_scope_id, p_role);
  perform ${entries}(p_scope, p_allow, p_deny, p_include);
${write}
end;`,
  false,
)}

${fn(
  "rename a custom role for a trusted caller",
  CUSTOM_ROLES.trustedRename,
  renameParams,
  renameArgs,
  `begin
  perform ${shape}(p_tenant, p_scope, p_scope_id, p_from);
${move}
end;`,
  false,
)}

${fn(
  "delete a custom role for a trusted caller",
  CUSTOM_ROLES.trustedRemove,
  removeParams,
  removeArgs,
  `begin
  perform ${shape}(p_tenant, p_scope, p_scope_id, p_role);
${remove}
end;`,
  false,
)}`;
}

/** `row.column`, for a trigger's `old` or `new`. */
function rowColumn(row: string, name: string): string {
  return `${row}.${quoteIdent(name)}`;
}

/** The custom-role rows of the role a trigger's `v_<prefix>_*` variables name. */
function cascadeMatch(prefix: string): string {
  return `c.tenant_id is not distinct from v_${prefix}_tenant and c.scope = v_${prefix}_scope and c.scope_id is not distinct from v_${prefix}_id and c.role = v_${prefix}_key`;
}

/**
 * The trigger on the application's roles table (`rls.customRoleWrites.roles`):
 * a rename, a move to another tenant, scope or instance, or a delete of a
 * custom role's row carries its grants and includes along. A signed-in
 * caller at trigger depth 1 passes the write functions' checks: authority
 * over the stored definition where it was, and, after a move, membership
 * and authority where it lands and entries inside that scope's ceiling.
 * Other paths (a migration, a job, a nested trigger) move the rows as the
 * function owner.
 */
export function customRoleCascadeSql(ctx: RlsSqlContext): string {
  const custom = ctx.customRoles;
  const table = custom?.table;
  const root = ctx.scopes[0]?.name;
  if (custom === undefined || table === undefined || root === undefined) {
    return "";
  }
  const tenantType = tenantTypeOf(ctx);
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const fn = qualified(ctx, CUSTOM_ROLES.cascade);
  const target = quoteTable(
    table.table.includes(".") ? table.table : `public.${table.table}`,
  );
  const tenant = (row: string): string =>
    table.tenant === undefined
      ? `null::${tenantType}`
      : `${rowColumn(row, table.tenant)}::${tenantType}`;
  const scope = (row: string): string =>
    table.scope === undefined
      ? `case when ${tenant(row)} is null then 'global' else ${quoteLiteral(root)} end`
      : `case when ${tenant(row)} is null then 'global' else ${rowColumn(row, table.scope)}::text end`;
  const id = (row: string): string =>
    table.id === undefined ? "null::text" : `${rowColumn(row, table.id)}::text`;
  const skipped = (row: string): string =>
    table.skip === undefined
      ? "false"
      : `coalesce(${rowColumn(row, table.skip)}, false)`;
  const guard = qualified(ctx, CUSTOM_ROLES.guard);
  const entries = qualified(ctx, CUSTOM_ROLES.entries);
  const allowEntryOf =
    custom.levels === true
      ? "c.permission || coalesce('@' || c.level, '')"
      : "c.permission";
  return `-- the application's roles table: renames, moves and deletes of a custom role carry its grants and includes
create or replace function ${fn}()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old_tenant ${tenantType} := ${tenant("old")};
  v_old_scope text := ${scope("old")};
  v_old_id text := ${id("old")};
  v_old_key text := ${rowColumn("old", table.key)}::text;
  v_new_tenant ${tenantType};
  v_new_scope text;
  v_new_id text;
  v_new_key text;
  v_checked boolean := ${signedIn(ctx)} and pg_trigger_depth() = 1;
  v_allow text[];
  v_deny text[];
  v_include text[];
begin
  if ${skipped("old")} then
    return null;
  end if;
  if tg_op = 'UPDATE' and not ${skipped("new")} then
    v_new_tenant := ${tenant("new")};
    v_new_scope := ${scope("new")};
    v_new_id := ${id("new")};
    v_new_key := ${rowColumn("new", table.key)}::text;
    if v_new_key = v_old_key
      and v_new_tenant is not distinct from v_old_tenant
      and v_new_scope = v_old_scope
      and v_new_id is not distinct from v_old_id then
      return null;
    end if;
  end if;
  if not exists (select 1 from ${perms} c where ${cascadeMatch("old")})
    and not exists (select 1 from ${includes} c where ${cascadeMatch("old")}) then
    return null;
  end if;
  if v_checked then
    perform ${guard}(v_old_tenant, v_old_scope, v_old_id, v_old_key);
  end if;
  if v_new_key is null then
    delete from ${perms} c where ${cascadeMatch("old")};
    delete from ${includes} c where ${cascadeMatch("old")};
    return null;
  end if;
  if exists (select 1 from ${perms} c where ${cascadeMatch("new")})
    or exists (select 1 from ${includes} c where ${cascadeMatch("new")}) then
${raiseSql("    ", "22023", `'permdock: ' || v_new_key || ' already has grants'`, "role-exists")}
  end if;
  update ${perms} c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where ${cascadeMatch("old")};
  update ${includes} c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where ${cascadeMatch("old")};
  if v_checked then
    perform ${guard}(v_new_tenant, v_new_scope, v_new_id, v_new_key);
    select array_agg(${allowEntryOf}) filter (where c.effect = 'allow'),
      array_agg(c.permission) filter (where c.effect = 'deny')
    into v_allow, v_deny
    from ${perms} c
    where ${cascadeMatch("new")};
    select array_agg(c.include_role) into v_include
    from ${includes} c
    where ${cascadeMatch("new")};
    perform ${entries}(v_new_scope, v_allow, v_deny, v_include);
  end if;
  return null;
end;
$$;
revoke execute on function ${fn}() from public, anon, authenticated;
drop trigger if exists "permdock_custom_role_cascade" on ${target};
create trigger "permdock_custom_role_cascade"
  after update or delete on ${target}
  for each row execute function ${fn}();
`;
}
