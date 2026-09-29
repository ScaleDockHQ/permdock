import type { RlsSqlContext } from './rls-sql.ts';
import type { RlsMembershipTable } from './types.ts';

import {
  quoteIdent,
  quoteLiteral,
  quoteTable,
  subjectClaimJsonSql,
  subjectClaimSql,
  subjectIdSql,
  teamTypeOf,
  tenantTypeOf,
} from './rls-sql.ts';

/** The per-statement helpers every generated policy calls. Names are part of the SQL contract. */
export const HELPERS = {
  has: 'permdock_has',
  tenants: 'permitted_tenant_ids',
  teams: 'permitted_team_ids',
} as const;

/** Objects `--custom-roles` adds next to the helpers. Names are part of the SQL contract. */
export const CUSTOM_ROLES = {
  permissions: 'custom_role_permissions',
  includes: 'custom_role_includes',
  ceiling: 'permdock_ceiling',
  keys: 'permdock_custom_keys',
} as const;

export type HelperScope = 'global' | 'tenant' | 'team';

/** One `role_permissions` row: `role` holds `grant_key`, which is `permission` or `permission#n`. */
export type RolePermission = {
  readonly role: string;
  readonly permission: string;
  readonly grantKey: string;
  readonly scope: HelperScope;
  readonly effect: 'allow' | 'deny';
};

export function helperSchema(ctx: RlsSqlContext): string {
  return ctx.schema ?? 'public';
}

function qualified(ctx: RlsSqlContext, name: string): string {
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
  switch (scope) {
    case 'global':
      return `(select ${qualified(ctx, HELPERS.has)}(${key}))`;
    case 'tenant':
    case 'team': {
      if (column === undefined) {
        throw new Error(
          `PermDock CLI: ${scope}-scoped grant needs definePolicy({ scopes.${scope} })`,
        );
      }
      const helper = scope === 'tenant' ? HELPERS.tenants : HELPERS.teams;
      return `${quoteIdent(column)} in (select ${qualified(ctx, helper)}(${key}))`;
    }
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

function membershipTable(name: string): string {
  return quoteTable(name.includes('.') ? name : `public.${name}`);
}

function signedIn(ctx: RlsSqlContext): string {
  return `coalesce(${subjectIdSql(ctx)}::text, '') <> ''`;
}

function activeTenant(ctx: RlsSqlContext): string {
  return `nullif(${subjectClaimSql(ctx, ctx.tenantClaim)}, '')`;
}

function roleRows(ctx: RlsSqlContext): string {
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

function membershipRows(ctx: RlsSqlContext): string {
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

function hasBody(ctx: RlsSqlContext): string {
  const rp = qualified(ctx, 'role_permissions');
  if (ctx.authorize === 'database') {
    return `  select exists (
    select 1
    from ${qualified(ctx, 'user_roles')} ur
    join ${rp} rp on rp.role = ur.role::text
    where ur.user_id = ${subjectIdSql(ctx)}
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )`;
  }
  return `  select ${signedIn(ctx)} and exists (
    select 1
    from ${roleRows(ctx)}
    join ${rp} rp on rp.role = r.role
    where rp.grant_key = p_grant
      and rp.scope = 'global'
  )`;
}

function memberColumn(name: string): string {
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
  scope: 'tenant' | 'team',
  allows: string,
  denies: string,
  includes: string,
): string {
  return `    and p_grant in (select ${qualified(ctx, CUSTOM_ROLES.keys)}(
      ${allows},
      ${denies},
      ${includes},
      '${scope}'
    ))`;
}

function tableBody(
  ctx: RlsSqlContext,
  scope: 'tenant' | 'team',
  table: RlsMembershipTable | undefined,
  type: string,
): string {
  const column = scope === 'tenant' ? table?.tenant : table?.team;
  if (table === undefined || column === undefined) {
    return `  select null::${type} where false -- no ${scope} memberships table configured`;
  }
  const tenantColumn = scope === 'tenant' ? column : table.tenant;
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
  const [owner, ...rest] = filters;
  const lines = [
    `  select ${memberColumn(column)}::${type}`,
    `  from ${membershipTable(table.table)} m`,
    `  join ${qualified(ctx, 'role_permissions')} rp on rp.role = ${memberColumn(table.role)}::text`,
    owner ?? '',
    '    and rp.grant_key = p_grant',
    `    and rp.scope = '${scope}'`,
    ...rest,
  ];
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return lines.join('\n');
  }
  const match = [
    scope === 'tenant'
      ? `c.tenant_id::text = ${memberColumn(column)}::text and c.team_id is null`
      : `c.team_id::text = ${memberColumn(column)}::text`,
    ...(scope === 'team' && table.tenant !== undefined
      ? [`c.tenant_id::text = ${memberColumn(table.tenant)}::text`]
      : []),
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

function claimBody(
  ctx: RlsSqlContext,
  scope: 'tenant' | 'team',
  type: string,
): string {
  const filters = `    and m ->> '${scope}' is not null
    and (${activeTenant(ctx)} is null or m ->> 'tenant' = ${activeTenant(ctx)})
    and case jsonb_typeof(m -> 'expiresAt')
      when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
      else true
    end`;
  const declared = `  select (m ->> '${scope}')::${type}
  from ${membershipRows(ctx)}
  join ${qualified(ctx, 'role_permissions')} rp on rp.role = r.role
  where ${signedIn(ctx)}
    and rp.grant_key = p_grant
    and rp.scope = '${scope}'
${filters}`;
  const custom = ctx.customRoles;
  if (custom === undefined) {
    return declared;
  }
  // A tenant custom role rides a tenant membership; a team custom role its team membership.
  return `${declared}
  union
  select (m ->> '${scope}')::${type}
  from ${membershipRows(ctx)}
  cross join lateral (select m -> 'grants' -> r.role as g) cg
  where ${signedIn(ctx)}
    and jsonb_typeof(cg.g) = 'array'
    and not (r.role = any(${textArray(custom.declared)}))
    and m ->> 'team' is ${scope === 'tenant' ? 'null' : 'not null'}
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
    const teamType = teamTypeOf(ctx);
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
  team_id ${teamType},
  role text not null,
  ${column} text not null${check}
);
create unique index if not exists ${quoteIdent(`${name}_key`)}
  on ${table} (tenant_id, coalesce(team_id::text, ''), role, ${unique});
alter table ${table} enable row level security;
revoke all on table ${table} from anon, authenticated, public;`);
    }
  }
  chunks.push(`-- the ceiling: keys of assignable declared roles, and the denies of those roles on the same permissions
create or replace view ${ceiling} with (security_invoker = true) as
select rp.scope, rp.role, rp.permission, rp.grant_key, rp.effect
from ${rp} rp
where rp.scope in ('tenant', 'team')
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

function scopedBody(
  ctx: RlsSqlContext,
  scope: 'tenant' | 'team',
  type: string,
): string {
  return ctx.authorize === 'database'
    ? tableBody(ctx, scope, ctx.memberships?.[scope], type)
    : claimBody(ctx, scope, type);
}

function helperFunction(
  ctx: RlsSqlContext,
  name: string,
  returns: string,
  body: string,
): string {
  const fn = qualified(ctx, name);
  return `create or replace function ${fn}(p_grant text)
returns ${returns}
language sql
stable
security definer
set search_path = ''
as $$
${body}
$$;
revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
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
  const tenantType = tenantTypeOf(ctx);
  const teamType = teamTypeOf(ctx);
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
  scope text not null check (scope in ('global', 'tenant', 'team')),
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
  chunks.push(helperFunction(ctx, HELPERS.has, 'boolean', hasBody(ctx)));
  chunks.push(
    helperFunction(
      ctx,
      HELPERS.tenants,
      `setof ${tenantType}`,
      scopedBody(ctx, 'tenant', tenantType),
    ),
  );
  chunks.push(
    helperFunction(
      ctx,
      HELPERS.teams,
      `setof ${teamType}`,
      scopedBody(ctx, 'team', teamType),
    ),
  );
  return `${chunks.join('\n\n')}\n`;
}
