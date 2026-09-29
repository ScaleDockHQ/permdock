import type { Policy } from '../index.ts';
import type { RlsSqlContext } from './rls-sql.ts';
import type { RlsActiveRow, RlsMembershipTable } from './types.ts';

import { scopeColumn } from '../conditions/compile.ts';
import { scopeChain } from '../core/scopes.ts';
import { authorizeSql } from '../supabase/index.ts';
import { roleNames } from './rls-grants.ts';
import { instancesActive } from './rls-helpers.ts';
import {
  activeRowSql,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  scopeTable,
} from './rls-sql.ts';

export type RbacAuthorizeMode = 'database' | 'jwt';

export type RbacOptions = {
  /** Postgres schema for the enums, tables and functions. Default `public`. */
  readonly schema: string;
  /**
   * `database` reads `user_roles` (and the memberships table) on every statement: role changes
   * apply immediately. `jwt` reads the hook-injected claims: no query, stale until the token refreshes.
   */
  readonly authorize: RbacAuthorizeMode;
  readonly memberships?: RlsMembershipTable;
  /** The policy's first scope; `authorize(permission, tenant)` answers for an instance of it. */
  readonly scope?: string;
  /** Declared role names when custom roles compile; `authorize()` then answers from them too. */
  readonly customRoles?: { readonly declared: readonly string[] };
  /** The helpers' context: the hook reads its scope tables (`jwt` mode) and suspension tables. */
  readonly context?: RlsSqlContext;
};

export type RbacScaffold = {
  /** Enums and `user_roles`: emitted before the helpers, which read `user_roles`. */
  readonly head: string;
  /** `authorize()`, the custom access token hook and the auth-admin grants. */
  readonly tail: string;
  readonly warnings: readonly string[];
};

export function parseRbacAuthorize(
  raw: string | undefined,
): RbacAuthorizeMode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'database' || raw === 'jwt') {
    return raw;
  }
  throw new Error(
    `PermDock CLI: --authorize must be database or jwt, got '${raw}'`,
  );
}

export function hookUri(schema: string): string {
  return `pg-functions://postgres/${schema}/custom_access_token_hook`;
}

function createEnum(
  schema: string,
  name: string,
  values: readonly string[],
): string {
  const list = values.map((value) => quoteLiteral(value)).join(', ');
  return `do $$ begin
  create type ${quoteTable(`${schema}.${name}`)} as enum (${list});
exception when duplicate_object then null;
end $$;`;
}

function col(name: string): string {
  return `m.${quoteIdent(name)}`;
}

function hookTable(name: string): string {
  return quoteTable(name.includes('.') ? name : `public.${name}`);
}

/** One `select` of canonical claim entries from `scope`'s membership table, or a warning. */
function claimEntriesSql(
  ctx: RlsSqlContext,
  scope: string,
  order: number,
): {
  readonly sql?: string;
  readonly table?: string;
  readonly warning?: string;
} {
  const mapped = scopeTable(ctx, scope);
  if (mapped === undefined) {
    return {};
  }
  const { table, column } = mapped;
  const within: string[] = [];
  const ancestors: string[] = [];
  for (const ancestor of scopeChain(ctx.scopes, scope).slice(1)) {
    const held = scopeColumn(table, ctx.scopes, ancestor);
    if (held === undefined) {
      return {
        warning: `the token hook writes no ${scope} memberships: the ${scope} memberships table has no ${ancestor} column, and a membership without every ancestor in within grants nothing`,
      };
    }
    ancestors.push(col(held));
    within.push(`${quoteLiteral(ancestor)}, ${col(held)}::text`);
  }
  const expires =
    table.expiresAt === undefined ? undefined : col(table.expiresAt);
  const via = table.via === undefined ? undefined : col(table.via);
  const keys = [
    col(column),
    ...ancestors,
    ...(via === undefined ? [] : [via]),
    ...(expires === undefined ? [] : [expires]),
  ];
  const fields = [
    `'scope', ${quoteLiteral(scope)}`,
    `'id', ${col(column)}::text`,
    ...(within.length === 0
      ? []
      : [`'within', jsonb_build_object(${within.join(', ')})`]),
    `'roles', jsonb_agg(distinct ${col(table.role)}::text order by ${col(table.role)}::text)`,
    ...(via === undefined ? [] : [`'via', ${via}::text`]),
    ...(expires === undefined
      ? []
      : [`'expiresAt', floor(extract(epoch from ${expires}))::bigint`]),
  ];
  const filters = [
    `where ${col(table.user)}::text = uid`,
    ...(expires === undefined
      ? []
      : [`  and (${expires} is null or ${expires} > now())`]),
    ...instancesActive(
      ctx,
      scope,
      (name) => {
        const held = scopeColumn(table, ctx.scopes, name);
        return held === undefined ? undefined : col(held);
      },
      '  ',
    ),
  ];
  return {
    table: table.table,
    sql: `select ${String(order)} as ord, jsonb_strip_nulls(jsonb_build_object(
    ${fields.join(',\n    ')}
  )) as entry
from ${hookTable(table.table)} m
${filters.join('\n')}
group by ${keys.join(', ')}`,
  };
}

/** A read policy and `select` grant for `supabase_auth_admin` on a table the hook reads. */
function authAdminRead(table: string, label: string): string {
  const t = hookTable(table);
  const policy = quoteIdent(`permdock_auth_admin_read_${label}`);
  return `grant select on table ${t} to supabase_auth_admin;
drop policy if exists ${policy} on ${t};
create policy ${policy} on ${t}
  as permissive for select
  to supabase_auth_admin
  using (true);`;
}

type Hook = {
  readonly declare: string;
  readonly suspended: string;
  readonly memberships: string;
  readonly grants: string;
  readonly warnings: readonly string[];
};

/**
 * The hook's user suspension check (both modes) and, in `jwt` mode, the
 * canonical `memberships` claim built from every mapped scope table. A
 * suspended user gets empty `user_role` and `memberships` claims, which
 * shadow any `app_metadata` fallback.
 */
function hookParts(ctx: RlsSqlContext | undefined, jwt: boolean): Hook {
  const warnings: string[] = [];
  const reads = new Map<string, string>();
  const users: RlsActiveRow | undefined = ctx?.suspension?.users;
  const entries: string[] = [];
  if (ctx !== undefined && jwt) {
    for (const [index, scope] of ctx.scopes.entries()) {
      const part = claimEntriesSql(ctx, scope.name, index);
      if (part.warning !== undefined) {
        warnings.push(part.warning);
      }
      if (part.sql !== undefined && part.table !== undefined) {
        entries.push(part.sql);
        reads.set(part.table, 'memberships');
      }
    }
  }
  const writesMemberships = entries.length > 0;
  if (writesMemberships) {
    for (const [name, row] of Object.entries(ctx?.suspension?.scopes ?? {})) {
      reads.set(row.table, reads.get(row.table) ?? `status_${name}`);
    }
  }
  if (users !== undefined) {
    reads.set(users.table, reads.get(users.table) ?? 'status_users');
  }
  const empty = writesMemberships
    ? `claims := jsonb_set(claims, '{memberships}', '[]'::jsonb);\n    `
    : '';
  const suspended =
    users === undefined
      ? ''
      : `
  if not ${activeRowSql(users, 'uid::uuid')} then
    claims := jsonb_set(claims, '{user_role}', '[]'::jsonb);
    ${empty}return jsonb_set(event, '{claims}', claims);
  end if;`;
  const memberships = writesMemberships
    ? `
  select coalesce(jsonb_agg(x.entry order by x.ord, x.entry ->> 'id', x.entry::text), '[]'::jsonb)
    into members
    from (
${entries.map((entry) => entry.replaceAll(/^/gmu, '      ')).join('\n      union all\n')}
    ) x;
  claims := jsonb_set(claims, '{memberships}', members);`
    : '';
  return {
    declare:
      users === undefined && !writesMemberships
        ? ''
        : `\n  uid text := event ->> 'user_id';${writesMemberships ? '\n  members jsonb;' : ''}`,
    suspended,
    memberships,
    grants: [...reads]
      .map(([table, label]) => authAdminRead(table, label))
      .join('\n'),
    warnings,
  };
}

/**
 * Supabase's Custom Claims and RBAC scaffold on top of the PermDock helpers:
 * enums, `user_roles`, `authorize()` over the shared `role_permissions`, the
 * custom access token hook, and the `supabase_auth_admin` grants the hook
 * needs. Policies never call `authorize()` per row; they call the helpers.
 * Never grants anything to `service_role`.
 */
export function rbacScaffold(
  policy: Policy,
  options: RbacOptions,
): RbacScaffold {
  const schema = options.schema;
  const q = (name: string): string => quoteTable(`${schema}.${name}`);
  const s = quoteIdent(schema);
  const permissions = [
    ...new Set(policy.grants.map((grant) => grant.permission.key)),
  ];
  const authorizeFn = authorizeSql({
    schema,
    authorize: options.authorize,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.memberships === undefined
      ? {}
      : { tenant: options.memberships }),
    ...(options.customRoles === undefined
      ? {}
      : { customRoles: options.customRoles }),
    ...(options.context?.suspension === undefined
      ? {}
      : { suspension: options.context.suspension }),
  });
  const hook = hookParts(options.context, options.authorize === 'jwt');
  const head = `-- rbac scaffold (Supabase Custom Claims and RBAC)
-- authorize: ${options.authorize}${options.authorize === 'jwt' ? ' (reads the hook claims; stale until the token refreshes)' : ' (reads user_roles on every statement)'}
-- enable the hook in supabase/config.toml:
--   [auth.hook.custom_access_token]
--   enabled = true
--   uri = "${hookUri(schema)}"
${schema === 'public' ? '' : `create schema if not exists ${s};\n`}${createEnum(schema, 'app_role', roleNames(policy))}
${createEnum(schema, 'app_permission', permissions)}

create table if not exists ${q('user_roles')} (
  user_id uuid not null references auth.users on delete cascade,
  role ${q('app_role')} not null,
  primary key (user_id, role)
);

alter table ${q('user_roles')} enable row level security;
`;
  const tail = `${authorizeFn}
revoke execute on function ${q('authorize')}(${q('app_permission')}, text) from public, anon;
grant execute on function ${q('authorize')}(${q('app_permission')}, text) to authenticated;

create or replace function ${q('custom_access_token_hook')}(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  held jsonb;${hook.declare}
begin${hook.suspended}
  select case count(*) when 0 then null when 1 then to_jsonb(min(ur.role::text)) else jsonb_agg(ur.role::text order by ur.role::text) end
    into held
    from ${q('user_roles')} ur
    where ur.user_id = (event ->> 'user_id')::uuid;
  if held is not null then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;${hook.memberships}
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema ${s} to supabase_auth_admin;
grant execute on function ${q('custom_access_token_hook')}(jsonb) to supabase_auth_admin;
revoke execute on function ${q('custom_access_token_hook')}(jsonb) from authenticated, anon, public;
grant select on table ${q('user_roles')} to supabase_auth_admin;
revoke all on table ${q('user_roles')} from authenticated, anon, public;
drop policy if exists "Allow auth admin to read user roles" on ${q('user_roles')};
create policy "Allow auth admin to read user roles" on ${q('user_roles')}
  as permissive for select
  to supabase_auth_admin
  using (true);
${hook.grants === '' ? '' : `${hook.grants}\n`}`;
  return { head, tail, warnings: hook.warnings };
}
