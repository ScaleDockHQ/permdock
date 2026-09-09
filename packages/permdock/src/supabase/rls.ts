import type { SupabaseRlsConfig, SupabaseRlsOptions } from './types.ts';

import { compact } from '../core/compact.ts';

function isTable(
  value: unknown,
): value is SupabaseRlsOptions['memberships'] & { readonly table: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'table' in value &&
    typeof (value as { readonly table?: unknown }).table === 'string'
  );
}

export function supabaseRls(
  options: SupabaseRlsOptions = {},
): SupabaseRlsConfig {
  const raw = options.memberships;
  const memberships =
    raw === undefined ? undefined : isTable(raw) ? { tenant: raw } : raw;
  return compact<SupabaseRlsConfig>({
    dialect: 'supabase',
    roleClaim: options.roleClaim ?? 'user_role',
    tenantClaim: options.tenantClaim ?? 'tenant_id',
    memberships,
  });
}

export function authorizeSql(
  options: { readonly tenant?: boolean } = {},
): string {
  const tenant = options.tenant === true;
  const tenantArg = tenant ? ',\n  requested_tenant uuid default null' : '';
  const tenantUse = tenant ? '\n  perform requested_tenant;' : '';
  return `create or replace function public.authorize(
  requested_permission public.app_permission${tenantArg}
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  binduid uuid;
  user_role public.app_role;
begin
  select (select auth.uid()) into binduid;
  select ur.role into user_role from public.user_roles ur where ur.user_id = binduid;
  if user_role is null then
    return false;
  end if;${tenantUse}
  return exists (
    select 1
    from public.role_permissions rp
    where rp.role = user_role
      and rp.permission = requested_permission
  );
end;
$$;
`;
}
