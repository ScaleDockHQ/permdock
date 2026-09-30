import type { RlsSqlContext } from './rls-sql.ts';

import { scopeColumn } from '../conditions/compile.ts';
import { scopeChain } from '../core/scopes.ts';
import {
  globalKindFilterSql,
  kindFilterSql,
  activeRowSql,
  permittedIdsHelper,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  scopeTable,
  scopeTypeOf,
  subjectClaimJsonSql,
  subjectClaimSql,
  subjectIdSql,
  tenantTypeOf,
} from './rls-sql.ts';

/**
 * The per-statement helpers every generated policy calls: `permdock_has` for
 * global roles and one `permitted_<scope>_ids` per scope
 * (`permittedIdsHelper`). Names are part of the SQL contract.
 */
export const HELPERS = {
  has: 'permdock_has',
} as const;

/** The helper `--capabilities` adds: ids of one resource a link capability claim reaches. Part of the SQL contract. */
const CAPABILITIES = {
  ids: 'permdock_capability_ids',
} as const;

/** Objects `--custom-roles` adds next to the helpers. Names are part of the SQL contract. */
const CUSTOM_ROLES = {
  permissions: 'custom_role_permissions',
  includes: 'custom_role_includes',
  ceiling: 'permdock_ceiling',
  keys: 'permdock_custom_keys',
} as const;

/** `'global'` or a scope name. */
export type HelperScope = string;

/** One `role_permissions` row: `role` holds `grant_key`, which is `permission` or `permission#n`. */
export type RolePermission = {
  readonly role: string;
  readonly permission: string;
  readonly grantKey: string;
  readonly scope: HelperScope;
  readonly effect: 'allow' | 'deny';
};

function helperSchema(ctx: RlsSqlContext): string {
  return ctx.schema ?? 'public';
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
  if (scope === 'global') {
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
  const args = [resource, role, permission].map(quoteLiteral).join(', ');
  return `${quoteIdent(field)}::text in (select ${qualified(ctx, CAPABILITIES.ids)}(${args}))`;
}

function capabilitiesSql(ctx: RlsSqlContext): string {
  if (ctx.capabilities !== true) {
    return '';
  }
  const fn = qualified(ctx, CAPABILITIES.ids);
  const claim = subjectClaimJsonSql(ctx, 'capability');
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
  return quoteTable(name.includes('.') ? name : `public.${name}`);
}

export function signedIn(ctx: RlsSqlContext): string {
  return `coalesce(${subjectIdSql(ctx)}::text, '') <> ''`;
}

function activeTenant(ctx: RlsSqlContext): string {
  return `nullif(${subjectClaimSql(ctx, ctx.tenantClaim)}, '')`;
}

function rootName(ctx: RlsSqlContext): string {
  return ctx.scopes[0]?.name ?? 'tenant';
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
function userActive(ctx: RlsSqlContext, indent: string): string[] {
  const row = ctx.suspension?.users;
  return row === undefined
    ? []
    : [`${indent}and ${activeRowSql(row, subjectIdSql(ctx))}`];
}

/**
 * `and exists (...)` lines for every suspendable instance on the chain of
 * `scope`'s membership: its own and each ancestor's. `idOf` gives the SQL for
 * the id the membership holds for a scope on that chain.
 */
function instancesActive(
  ctx: RlsSqlContext,
  scope: string,
  idOf: (name: string) => string | undefined,
  indent: string,
): string[] {
  const lines: string[] = [];
  for (const name of scopeChain(ctx.scopes, scope)) {
    const row = ctx.suspension?.scopes?.[name];
    if (row === undefined) {
      continue;
    }
    const id = idOf(name);
    if (id === undefined) {
      throw new Error(
        `PermDock CLI: rls.suspension.scopes.${name} needs the ${name} id on ${scope} memberships: add columns.${name} to the ${scope} memberships table`,
      );
    }
    lines.push(
      `${indent}and ${activeRowSql(row, `(${id})::${scopeTypeOf(ctx, name)}`)}`,
    );
  }
  return lines;
}

export function roleRows(ctx: RlsSqlContext): string {
  const claim = ctx.roleClaim ?? 'user_role';
  switch (ctx.dialect) {
    case 'guc':
      return `unnest(string_to_array(nullif(current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true), ''), ',')) r(role)`;
    case 'supabase':
    case 'neon': {
      const raw = subjectClaimJsonSql(ctx, claim);
      // A top-level null falls back to app_metadata, like subjectFromSupabase.
      const value =
        ctx.dialect === 'supabase'
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
  const raw = subjectClaimJsonSql(ctx, 'memberships');
  const value =
    ctx.dialect === 'supabase'
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
  return condition === undefined ? '' : `\n${indent}and ${condition}`;
}

function hasBody(ctx: RlsSqlContext): string {
  const rp = qualified(ctx, 'role_permissions');
  const active = userActive(ctx, '      ')
    .map((line) => `\n${line}`)
    .join('');
  if (ctx.authorize === 'database') {
    return `  select exists (
    select 1
    from ${qualified(ctx, 'user_roles')} ur
    join ${rp} rp on rp.role = ur.role::text
    where ur.user_id = ${subjectIdSql(ctx)}
      and rp.grant_key = p_grant
      and rp.scope = 'global'${andLine('      ', globalKindFilterSql(ctx, 'ur.role::text'))}${active}
  )`;
  }
  return `  select ${signedIn(ctx)} and exists (
    select 1
    from ${roleRows(ctx)}
    join ${rp} rp on rp.role = r.role
    where rp.grant_key = p_grant
      and rp.scope = 'global'${andLine('      ', globalKindFilterSql(ctx, 'r.role'))}${active}
  )`;
}

export function memberColumn(name: string): string {
  return `m.${quoteIdent(name)}`;
}

/** Entries of a compact custom-role claim (`cg.g`) that match `where`. */
function claimEntries(where: string, value: string): string {
  return `array(select ${value} from jsonb_array_elements_text(cg.g) e where ${where})`;
}

function textArray(values: readonly string[]): string {
  return values.length === 0
    ? `'{}'::text[]`
    : `array[${values.map(quoteLiteral).join(', ')}]::text[]`;
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
    ...userActive(ctx, '    '),
    ...instancesActive(
      ctx,
      scope,
      (name) => {
        const held = scopeColumn(table, ctx.scopes, name);
        return held === undefined ? undefined : memberColumn(held);
      },
      '    ',
    ),
  );
  const [owner, ...rest] = filters;
  const kind = kindFilterSql(
    ctx,
    `${memberColumn(table.role)}::text`,
    table.via === undefined ? 'null::text' : `${memberColumn(table.via)}::text`,
  );
  const lines = [
    `  select ${memberColumn(column)}::${type}`,
    `  from ${membershipTable(table.table)} m`,
    `  join ${qualified(ctx, 'role_permissions')} rp on rp.role = ${memberColumn(table.role)}::text`,
    owner ?? '',
    '    and rp.grant_key = p_grant',
    `    and rp.scope = ${quoteLiteral(scope)}`,
    ...(kind === undefined ? [] : [`    and ${kind}`]),
    ...rest,
  ];
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return lines.join('\n');
  }
  // A custom role belongs to a tenant, is held at one scope, and may be pinned to one instance of it.
  const tenantOf = tenantColumn ?? column;
  const match = [
    `c.tenant_id::text = ${memberColumn(tenantOf)}::text`,
    `c.scope = ${quoteLiteral(scope)}`,
    `(c.scope_id is null or c.scope_id = ${memberColumn(column)}::text)`,
    `c.role = ${memberColumn(table.role)}::text`,
  ].join(' and ');
  const rows = (source: string, value: string, extra: string): string =>
    `array(select c.${value} from ${qualified(ctx, source)} c where ${match}${extra})`;
  return [
    ...lines,
    '  union',
    `  select ${memberColumn(column)}::${type}`,
    `  from ${membershipTable(table.table)} m`,
    ...filters,
    `    and not (${memberColumn(table.role)}::text = any(${textArray(custom.declared)}))`,
    customKeysSql(
      ctx,
      scope,
      rows(CUSTOM_ROLES.permissions, 'permission', " and c.effect = 'allow'"),
      rows(CUSTOM_ROLES.permissions, 'permission', " and c.effect = 'deny'"),
      rows(CUSTOM_ROLES.includes, 'include_role', ''),
    ),
  ].join('\n');
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
    : '';
  const filters = `    and m ->> 'scope' = ${quoteLiteral(scope)}
    and m ->> 'id' is not null${narrow}
    and case jsonb_typeof(m -> 'expiresAt')
      when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
      else true
    end${[
      ...userActive(ctx, '    '),
      ...instancesActive(
        ctx,
        scope,
        (name) =>
          name === scope
            ? `m ->> 'id'`
            : `m -> 'within' ->> ${quoteLiteral(name)}`,
        '    ',
      ),
    ]
      .map((line) => `\n${line}`)
      .join('')}`;
  const declared = `  select (m ->> 'id')::${type}
  from ${membershipRows(ctx)}
  join ${qualified(ctx, 'role_permissions')} rp on rp.role = r.role
  where ${signedIn(ctx)}
    and rp.grant_key = p_grant
    and rp.scope = ${quoteLiteral(scope)}${andLine('    ', kindFilterSql(ctx, 'r.role', "m ->> 'via'"))}
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
  claimEntries("left(e, 1) not in ('-', '@')", 'e'),
  claimEntries("left(e, 1) = '-'", 'substr(e, 2)'),
  claimEntries("left(e, 1) = '@'", 'substr(e, 2)'),
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
    return '';
  }
  const rp = qualified(ctx, 'role_permissions');
  const ceiling = qualified(ctx, CUSTOM_ROLES.ceiling);
  const keys = qualified(ctx, CUSTOM_ROLES.keys);
  const chunks: string[] = [];
  if (ctx.authorize === 'database') {
    const tenantType = tenantTypeOf(ctx);
    for (const [name, column, check] of [
      [
        CUSTOM_ROLES.permissions,
        'permission',
        `,
  effect text not null default 'allow' check (effect in ('allow', 'deny'))`,
      ],
      [CUSTOM_ROLES.includes, 'include_role', ''],
    ] as const) {
      const table = qualified(ctx, name);
      const unique = `${column}${name === CUSTOM_ROLES.permissions ? ', effect' : ''}`;
      chunks.push(`create table if not exists ${table} (
  tenant_id ${tenantType} not null,
  scope text not null default ${quoteLiteral(rootName(ctx))},
  scope_id text,
  role text not null,
  ${column} text not null${check}
);
create unique index if not exists ${quoteIdent(`${name}_key`)}
  on ${table} (tenant_id, scope, coalesce(scope_id, ''), role, ${unique});
alter table ${table} enable row level security;
revoke all on table ${table} from anon, authenticated, public;`);
    }
  }
  chunks.push(`-- the ceiling: keys of assignable declared roles, and the denies of those roles on the same permissions
create or replace view ${ceiling} with (security_invoker = true) as
select rp.scope, rp.role, rp.permission, rp.grant_key, rp.effect
from ${rp} rp
where rp.scope <> 'global'
  and rp.role = any(${textArray(custom.assignable)})
  and exists (
    select 1 from ${rp} a
    where a.role = rp.role
      and a.permission = rp.permission
      and a.scope = rp.scope
      and a.effect = 'allow'
  );
revoke all on table ${ceiling} from anon, authenticated, public;`);
  chunks.push(`-- one custom role: included ceiling keys and same-scope denies, plus every ceiling key of an allowed permission, minus denied permissions
create or replace function ${keys}(p_allow text[], p_deny text[], p_include text[], p_scope text)
returns setof text
language sql
stable
set search_path = ''
as $$
  with ceiling as (
    select c.role, c.permission, c.grant_key, c.effect
    from ${ceiling} c
    where c.scope = p_scope
  ),
  included as (
    select rp.role, rp.permission, rp.grant_key, rp.scope, rp.effect
    from ${rp} rp
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
    select unnest(coalesce(p_allow, '{}'::text[])) as permission
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
    where not (w.permission = any(coalesce(p_deny, '{}'::text[])))
      and not exists (select 1 from kept k where k.permission = w.permission)
  )
  select k.grant_key from kept k
  where not (k.permission = any(coalesce(p_deny, '{}'::text[])))
  union
  select i.grant_key from included i
  where i.effect = 'deny' and i.scope = p_scope
  union
  select c.grant_key from ceiling c
  where c.permission in (select a.permission from allowed a)
$$;
revoke execute on function ${keys}(text[], text[], text[], text) from public, anon, authenticated;`);
  return chunks.join('\n\n');
}

function scopedBody(ctx: RlsSqlContext, scope: string, type: string): string {
  return ctx.authorize === 'database'
    ? tableBody(ctx, scope, type)
    : claimBody(ctx, scope, type);
}

function helperFunction(
  ctx: RlsSqlContext,
  name: string,
  returns: string,
  body: string,
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
language sql
stable
security definer
set search_path = ''
as $$
${body}
$$;
${grants}`;
}

function userIdType(ctx: RlsSqlContext): string {
  return ctx.dialect === 'supabase'
    ? 'uuid not null references auth.users on delete cascade'
    : 'text not null';
}

function seedSql(ctx: RlsSqlContext, rows: readonly RolePermission[]): string {
  const table = qualified(ctx, 'role_permissions');
  if (rows.length === 0) {
    return `delete from ${table};`;
  }
  const values = rows
    .map(
      (row) =>
        `  (${[row.role, row.permission, row.grantKey, row.scope, row.effect].map(quoteLiteral).join(', ')})`,
    )
    .join(',\n');
  const keys = rows
    .map(
      (row) =>
        `  (${[row.role, row.grantKey, row.scope].map(quoteLiteral).join(', ')})`,
    )
    .join(',\n');
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
  const rp = qualified(ctx, 'role_permissions');
  const chunks = [
    `-- permdock helpers (${ctx.authorize === 'database' ? 'database: reads the membership and user_roles tables' : 'jwt: reads the role and memberships claims'})
-- policies call them uncorrelated, so Postgres evaluates each once per statement`,
  ];
  if (schema !== 'public') {
    chunks.push(
      `create schema if not exists ${s};\ngrant usage on schema ${s} to authenticated;`,
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
  chunks.push(seedSql(ctx, rows));
  if (ctx.authorize === 'database' && options.userRoles) {
    const ur = qualified(ctx, 'user_roles');
    chunks.push(`create table if not exists ${ur} (
  user_id ${userIdType(ctx)},
  role text not null,
  primary key (user_id, role)
);
alter table ${ur} enable row level security;
revoke all on table ${ur} from anon, authenticated, public;`);
  }
  const custom = customRolesSql(ctx);
  if (custom !== '') {
    chunks.push(custom);
  }
  const anon = options.anonExecute === true;
  chunks.push(helperFunction(ctx, HELPERS.has, 'boolean', hasBody(ctx), anon));
  const capabilities = capabilitiesSql(ctx);
  if (capabilities !== '') {
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
  }
  return `${chunks.join('\n\n')}\n`;
}
