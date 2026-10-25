-- better-supabase module: permissions
-- @bsb-block permissions@1 managed
-- @bsb-hash sha256:227e0ae055fecfb23732fdfae4b0eb64031525b70c27e12e4f19455e3e96653c
-- can(), tenant_ids_with() and is_platform(): one permission contract for policies and SQL modules, over a roles list, a role and permission catalog, an authorization provider or the app's own functions (blocks.permissions.model).
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create schema if not exists better_supabase;
grant usage on schema better_supabase to anon, authenticated, service_role;
grant usage on schema better_supabase to supabase_auth_admin;

-- Disabled tenants and users get no permissions and no membership claims
-- (blocks.permissions.disabled; with the managed organizations module, its
-- disabled_at and deleted_at columns).
create or replace function better_supabase.tenant_disabled(tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select false
$$;

create or replace function better_supabase.user_disabled(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select false
$$;

revoke execute on function better_supabase.tenant_disabled(uuid) from public, anon, authenticated;
revoke execute on function better_supabase.user_disabled(uuid) from public, anon, authenticated;
grant execute on function better_supabase.tenant_disabled(uuid) to service_role, supabase_auth_admin;
grant execute on function better_supabase.user_disabled(uuid) to service_role, supabase_auth_admin;

-- `*` grants every key and `prefix.*` every key under prefix.
create or replace function better_supabase.permission_matches(granted text, wanted text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select granted = '*' or granted = wanted
    or (right(granted, 2) = '.*' and starts_with(wanted, left(granted, -1)))
$$;

-- The permission keys an OAuth scope grants a delegated token
-- (authorization.delegation.scopes, blocks.permissions.scopes). A scope
-- without an entry grants the key with its own name.
create or replace function better_supabase.scope_permissions(scope text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case scope
    when 'audit:read' then array['audit.read']::text[]
    when 'audit:revert' then array['audit.revert']::text[]
    when 'quotes:list' then array['quotes.list']::text[]
    when 'quotes:read' then array['quotes.read']::text[]
    when 'quotes:update' then array['quotes.update']::text[]
    when 'roles:manage' then array['roles.manage']::text[]
    when 'staff:list' then array['staff.list']::text[]
    when 'staff:read' then array['staff.read']::text[]
    else array[scope]
  end
$$;

-- False when the token is narrower than the permission: a permission cap
-- (bsb_permission_cap) without the key, or a delegated token whose scopes
-- don't map to it. True for every other token, the service role included.
-- 0.14 named the cap bs_permission_cap; 0.15 still reads it when the new
-- claim is missing, so a cap from an older runAs keeps narrowing.
create or replace function better_supabase.cap_allows(permission text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when jwt is null then true
    when jsonb_typeof(cap) = 'array'
      and not exists (
        select 1 from jsonb_array_elements_text(cap) c(key)
        where better_supabase.permission_matches(c.key, cap_allows.permission)
      ) then false
    when coalesce(jwt ->> 'client_id', '') = ''
      and (jwt -> 'act' is null
        or (jsonb_typeof(jwt -> 'act') = 'object'
          and jwt -> 'act' ->> 'kind' in ('support', 'impersonation'))) then true
    else exists (
      select 1
      from unnest(case jsonb_typeof(jwt -> 'scope')
          when 'string' then regexp_split_to_array(btrim(jwt ->> 'scope'), '\s+')
          when 'array' then array(select jsonb_array_elements_text(jwt -> 'scope'))
          else '{}'::text[]
        end) s(scope)
      cross join lateral unnest(better_supabase.scope_permissions(s.scope)) k(key)
      where s.scope <> ''
        and better_supabase.permission_matches(k.key, cap_allows.permission)
    )
  end
  from (select auth.jwt() as jwt) as token
  cross join lateral (
    select coalesce(jwt -> 'bsb_permission_cap', jwt -> 'bs_permission_cap') as cap
  ) as capped
$$;

-- The permission key an operation (<module>.<action>, or a name in
-- authorization.operations) checks, after renames and the provider's table.
-- Null for an operation nobody declared, which callers refuse.
create or replace function better_supabase.operation_permission(op text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case op
    when 'audit.revert' then 'audit.revert'
    when 'audit.view' then 'audit.read'
    when 'audit.viewAll' then 'audit.read'
    when 'share-links.create' then 'quotes.update'
    when 'share-links.read' then 'quotes.read'
  end
$$;

-- The provider model: the authorization provider (PermDock) decides,
-- through authorization.functions in better-supabase.config.ts. Its caller
-- functions read auth.uid(), so member_can() and can_user() answer for
-- another user through its idsWithFor and isPlatformFor.
create or replace function better_supabase.member_can(member uuid, tenant uuid, permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if member is distinct from auth.uid() then
    return not better_supabase.user_disabled(member)
      and not better_supabase.tenant_disabled(tenant)
      and tenant::text in (select t.id::text from permdock.permitted_organization_ids_by_permission_for(member, permission) as t(id));
  end if;
  return not better_supabase.user_disabled(member)
    and not better_supabase.tenant_disabled(tenant)
    and better_supabase.cap_allows(permission)
    and tenant::text in (select t.id::text from permdock.permitted_organization_ids_by_permission(permission) as t(id));
end;
$$;

-- member_can without the disabled-tenant check, for the actions a member
-- takes while the tenant waits to be purged, such as cancelling the deletion.
create or replace function better_supabase.member_can_while_deleting(member uuid, tenant uuid, permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if member is distinct from auth.uid() then
    return not better_supabase.user_disabled(member)
      and tenant::text in (select t.id::text from permdock.permitted_organization_ids_by_permission_for(member, permission) as t(id));
  end if;
  return not better_supabase.user_disabled(member)
    and better_supabase.cap_allows(permission)
    and tenant::text in (select t.id::text from permdock.permitted_organization_ids_by_permission(permission) as t(id));
end;
$$;

-- The permission keys a member holds in a tenant, from the provider's permissionsFor.
create or replace function better_supabase.member_permissions(member uuid, tenant uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when member is not null
      and not better_supabase.user_disabled(member)
      and not better_supabase.tenant_disabled(tenant)
    then coalesce((array(select permdock.permitted_organization_permission_keys_for(member, tenant))), '{}'::text[])
    else '{}'::text[]
  end
$$;

-- { [tenant id]: permission keys } over the provider's memberIdsFor.
create or replace function better_supabase.permission_claims(user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(better_supabase.member_permissions(permission_claims.user_id, t.id::uuid))), '{}'::jsonb)
  from permdock.member_organization_ids_for(permission_claims.user_id) as t(id)
  where not better_supabase.user_disabled(permission_claims.user_id)
    and not better_supabase.tenant_disabled(t.id::uuid)
$$;

create or replace function better_supabase.platform_can(member uuid, permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when member = auth.uid() then (platform_can.member is distinct from auth.uid() or auth.jwt() -> 'act' is null) and not better_supabase.user_disabled(member) and better_supabase.cap_allows(permission) and coalesce((permdock.permdock_has_permission(permission)), false)
    when member is not null then (platform_can.member is distinct from auth.uid() or auth.jwt() -> 'act' is null) and not better_supabase.user_disabled(member) and coalesce((permdock.permdock_has_permission_for(member, permission)), false)
    else false
  end
$$;

create or replace function better_supabase.tenant_ids_with(permission text)
returns setof uuid
language sql
rows 1
stable
security definer
set search_path = ''
as $$
  select t.id::uuid from permdock.permitted_organization_ids_by_permission(tenant_ids_with.permission) as t(id)
  where better_supabase.cap_allows(tenant_ids_with.permission)
    and not better_supabase.user_disabled(auth.uid())
    and not better_supabase.tenant_disabled(t.id::uuid)
$$;

-- blocks.permissions.functions.canAssign, else authorization.functions.canAssign,
-- decides who assigns which role. Without either, only the service role
-- assigns roles.
create or replace function better_supabase.can_assign(tenant uuid, role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role' or coalesce((false), false)
$$;

-- The access contract. Policies and SQL modules call these, never a model's
-- tables, so the model can change without touching them. In a policy, use
-- the set, which runs once per statement and can use the tenant index:
--   using (organization_id in (select better_supabase.tenant_ids_with('invoices.read')))
-- can() with a column argument runs once per row, even inside (select ...);
-- keep it for checks on one row and inside functions.
create or replace function better_supabase.can(scope text, scope_id uuid, permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when can.scope = 'platform' then coalesce(better_supabase.platform_can(auth.uid(), can.permission), false)
    when can.scope in ('organization', 'tenant') then coalesce(better_supabase.member_can(auth.uid(), can.scope_id, can.permission), false)
    else false
  end
$$;

-- The same question for another user, for checks such as an inviter's
-- authority at accept time. The provider model answers through the provider's idsWithFor and isPlatformFor.
create or replace function better_supabase.can_user(member uuid, scope text, scope_id uuid, permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return case
    when can_user.scope = 'platform' then better_supabase.platform_can(can_user.member, can_user.permission)
    when can_user.scope in ('organization', 'tenant') then better_supabase.member_can(can_user.member, can_user.scope_id, can_user.permission)
    else false
  end;
end;
$$;

create or replace function better_supabase.is_platform(permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(better_supabase.platform_can(auth.uid(), is_platform.permission), false)
$$;

-- The caller's permission keys in a tenant, for client checks. With keys,
-- the ones can() grants: every model answers, including a provider and
-- delegated tokens. Without them, the keys the model lists for the member,
-- wildcards as granted (the custom model lists none).
create or replace function better_supabase.my_permissions(tenant uuid, keys text[] default null)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null or my_permissions.tenant is null then '{}'::text[]
    when my_permissions.keys is not null then coalesce((
      select array_agg(distinct k order by k)
      from unnest(my_permissions.keys) as k
      where better_supabase.can('tenant', my_permissions.tenant, k)
    ), '{}'::text[])
    when better_supabase.tenant_disabled(my_permissions.tenant) then '{}'::text[]
    else coalesce((
      select array_agg(distinct p order by p)
      from unnest(better_supabase.member_permissions(auth.uid(), my_permissions.tenant)) as p
      where better_supabase.cap_allows(p)
    ), '{}'::text[])
  end
$$;

revoke execute on function better_supabase.permission_matches(text, text) from public;
grant execute on function better_supabase.permission_matches(text, text) to anon, authenticated, service_role;
revoke execute on function better_supabase.scope_permissions(text) from public;
grant execute on function better_supabase.scope_permissions(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.cap_allows(text) from public;
grant execute on function better_supabase.cap_allows(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.operation_permission(text) from public;
grant execute on function better_supabase.operation_permission(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.can(text, uuid, text) from public;
grant execute on function better_supabase.can(text, uuid, text) to anon, authenticated, service_role;
revoke execute on function better_supabase.tenant_ids_with(text) from public;
grant execute on function better_supabase.tenant_ids_with(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.is_platform(text) from public;
grant execute on function better_supabase.is_platform(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.can_assign(uuid, text) from public;
grant execute on function better_supabase.can_assign(uuid, text) to anon, authenticated, service_role;
revoke execute on function better_supabase.my_permissions(uuid, text[]) from public;
grant execute on function better_supabase.my_permissions(uuid, text[]) to anon, authenticated, service_role;
revoke execute on function better_supabase.member_can(uuid, uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.member_can(uuid, uuid, text) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.member_can_while_deleting(uuid, uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.member_can_while_deleting(uuid, uuid, text) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.member_permissions(uuid, uuid) from public, anon, authenticated;
grant execute on function better_supabase.member_permissions(uuid, uuid) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.platform_can(uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.platform_can(uuid, text) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.can_user(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.can_user(uuid, text, uuid, text) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.permission_claims(uuid) from public, anon, authenticated;
grant execute on function better_supabase.permission_claims(uuid) to service_role, supabase_auth_admin;

-- The permission claim: { [tenant id]: permission keys }, for the access
-- token hook when the app checks permissions from the token:
--   return jsonb_set(event, '{claims,permissions}',
--     better_supabase.permission_claims((event ->> 'user_id')::uuid));

create schema if not exists better_supabase;
create table if not exists better_supabase.blocks (
  name text primary key,
  block text,
  version integer not null,
  mode text not null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table better_supabase.blocks enable row level security;
revoke all on better_supabase.blocks from anon, authenticated;
grant select on better_supabase.blocks to service_role;
