import type {
  AuthorizeSqlOptions,
  SupabaseMembershipTable,
  SupabaseRlsConfig,
  SupabaseRlsOptions,
} from './types.ts';

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

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function ident(name: string): string {
  if (!IDENT.test(name)) {
    throw new TypeError(`PermDock: unsafe SQL identifier '${name}'`);
  }
  return `"${name}"`;
}

function table(name: string): string {
  return name.split('.').map(ident).join('.');
}

// `authorize()` runs with `search_path = ''`, so a bare table name must be qualified.
function qualifiedTable(name: string): string {
  return table(name.includes('.') ? name : `public.${name}`);
}

function databaseBody(
  q: (name: string) => string,
  memberships: SupabaseMembershipTable | undefined,
): string {
  const tenantColumn = memberships?.tenant;
  const tenantBranch =
    memberships === undefined || tenantColumn === undefined
      ? `  if requested_tenant is not null then
    return false; -- no memberships table configured
  end if;`
      : `  if requested_tenant is not null then
    return exists (
      select 1
      from ${qualifiedTable(memberships.table)} m
      join ${q('role_permissions')} rp on rp.role = m.${ident(memberships.role)}::text
      where m.${ident(memberships.user)}::text = uid::text
        and m.${ident(tenantColumn)}::text = requested_tenant
        and rp.permission = requested_permission::text
        and rp.scope = 'tenant'
        and rp.effect = 'allow'${
          memberships.expiresAt === undefined
            ? ''
            : `\n        and (m.${ident(memberships.expiresAt)} is null or m.${ident(memberships.expiresAt)} > now())`
        }
    );
  end if;`;
  return `declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    return false;
  end if;
${tenantBranch}
  return exists (
    select 1
    from ${q('user_roles')} ur
    join ${q('role_permissions')} rp on rp.role = ur.role::text
    where ur.user_id = uid
      and rp.permission = requested_permission::text
      and rp.scope = 'global'
      and rp.effect = 'allow'
  );
end;`;
}

function jwtBody(q: (name: string) => string): string {
  return `declare
  claims jsonb := (select auth.jwt());
  role_claim jsonb;
begin
  if claims is null or (select auth.uid()) is null then
    return false;
  end if;
  if requested_tenant is not null then
    return exists (
      select 1
      from jsonb_array_elements(
        case jsonb_typeof(coalesce(claims -> 'memberships', claims -> 'app_metadata' -> 'memberships'))
          when 'array' then coalesce(claims -> 'memberships', claims -> 'app_metadata' -> 'memberships')
          else '[]'::jsonb
        end
      ) m
      cross join lateral jsonb_array_elements_text(
        case jsonb_typeof(m -> 'roles') when 'array' then m -> 'roles' else '[]'::jsonb end
      ) r(role)
      join ${q('role_permissions')} rp on rp.role = r.role
      where m ->> 'tenant' = requested_tenant
        and rp.permission = requested_permission::text
        and rp.scope = 'tenant'
        and rp.effect = 'allow'
    );
  end if;
  -- a top-level null (no role row) falls back to app_metadata, like subjectFromSupabase
  role_claim := coalesce(nullif(claims -> 'user_role', 'null'::jsonb), claims -> 'app_metadata' -> 'user_role');
  return exists (
    select 1
    from jsonb_array_elements_text(
      case jsonb_typeof(role_claim)
        when 'array' then role_claim
        when 'string' then jsonb_build_array(role_claim)
        else '[]'::jsonb
      end
    ) r(role)
    join ${q('role_permissions')} rp on rp.role = r.role
    where rp.permission = requested_permission::text
      and rp.scope = 'global'
      and rp.effect = 'allow'
  );
end;`;
}

/**
 * `authorize(requested_permission, requested_tenant text default null)` for Supabase's RBAC
 * scaffold, over the `role_permissions (role, permission, grant_key, scope, effect)` table that
 * `permdock rls generate` seeds. `database` reads `user_roles` (and the memberships table for a
 * tenant) on every call; `jwt` reads the hook-injected `user_role` and `memberships` claims. A
 * tenant request with no memberships source is denied, never answered from global roles. It
 * answers "does a role hold this permission", ignoring row conditions and denies: generated
 * policies call the per-statement `permdock_*` helpers instead.
 */
export function authorizeSql(options: AuthorizeSqlOptions = {}): string {
  const schema = options.schema ?? 'public';
  const q = (name: string): string => table(`${schema}.${name}`);
  const memberships =
    typeof options.tenant === 'object' ? options.tenant : undefined;
  const body =
    options.authorize === 'jwt' ? jwtBody(q) : databaseBody(q, memberships);
  return `create or replace function ${q('authorize')}(
  requested_permission ${q('app_permission')},
  requested_tenant text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
${body}
$$;
`;
}
