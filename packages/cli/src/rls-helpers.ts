import type { RlsSqlContext } from './rls-sql.ts';
import type { RlsMembershipTable } from './types.ts';

import {
  quoteIdent,
  quoteLiteral,
  quoteTable,
  subjectClaimJsonSql,
  subjectClaimSql,
  subjectIdSql,
} from './rls-sql.ts';

/** The per-statement helpers every generated policy calls. Names are part of the SQL contract. */
export const HELPERS = {
  has: 'permdock_has',
  tenants: 'permdock_tenants_with',
  teams: 'permdock_teams_with',
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

const SQL_TYPE = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*(\[\])?$/u;

export function sqlType(name: string): string {
  if (!SQL_TYPE.test(name)) {
    throw new Error(`PermDock CLI: unsafe SQL type '${name}'`);
  }
  return name;
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
  const lines = [
    `  select m.${quoteIdent(column)}::${type}`,
    `  from ${membershipTable(table.table)} m`,
    `  join ${qualified(ctx, 'role_permissions')} rp on rp.role = m.${quoteIdent(table.role)}::text`,
    `  where m.${quoteIdent(table.user)} = ${subjectIdSql(ctx)}`,
    '    and rp.grant_key = p_grant',
    `    and rp.scope = '${scope}'`,
  ];
  if (table.expiresAt !== undefined) {
    const expires = `m.${quoteIdent(table.expiresAt)}`;
    lines.push(`    and (${expires} is null or ${expires} > now())`);
  }
  if (tenantColumn !== undefined) {
    lines.push(
      `    and (${activeTenant(ctx)} is null or m.${quoteIdent(tenantColumn)}::text = ${activeTenant(ctx)})`,
    );
  }
  return lines.join('\n');
}

function claimBody(
  ctx: RlsSqlContext,
  scope: 'tenant' | 'team',
  type: string,
): string {
  return `  select (m ->> '${scope}')::${type}
  from ${membershipRows(ctx)}
  join ${qualified(ctx, 'role_permissions')} rp on rp.role = r.role
  where ${signedIn(ctx)}
    and rp.grant_key = p_grant
    and rp.scope = '${scope}'
    and m ->> '${scope}' is not null
    and (${activeTenant(ctx)} is null or m ->> 'tenant' = ${activeTenant(ctx)})
    and case jsonb_typeof(m -> 'expiresAt')
      when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
      else true
    end`;
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
  readonly tenantType: string;
  readonly teamType: string;
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
  const tenantType = sqlType(options.tenantType);
  const teamType = sqlType(options.teamType);
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
