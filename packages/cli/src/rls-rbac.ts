import type { Policy } from 'permdock';

import { authorizeSql } from 'permdock/supabase';

import type { RlsMembershipTable } from './types.ts';

import { roleNames } from './rls-grants.ts';
import { quoteIdent, quoteLiteral, quoteTable } from './rls-sql.ts';

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
  /** Declared role names when custom roles compile; `authorize()` then answers from them too. */
  readonly customRoles?: { readonly declared: readonly string[] };
};

export type RbacScaffold = {
  /** Enums and `user_roles`: emitted before the helpers, which read `user_roles`. */
  readonly head: string;
  /** `authorize()`, the custom access token hook and the auth-admin grants. */
  readonly tail: string;
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
    ...(options.memberships === undefined
      ? {}
      : { tenant: options.memberships }),
    ...(options.customRoles === undefined
      ? {}
      : { customRoles: options.customRoles }),
  });
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
  held jsonb;
begin
  select case count(*) when 0 then null when 1 then to_jsonb(min(ur.role::text)) else jsonb_agg(ur.role::text order by ur.role::text) end
    into held
    from ${q('user_roles')} ur
    where ur.user_id = (event ->> 'user_id')::uuid;
  if held is not null then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
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
`;
  return { head, tail };
}
