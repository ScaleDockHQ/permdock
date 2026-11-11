-- better-supabase module: permissions
-- @bsb-block permissions@1 managed
-- @bsb-hash sha256:16aaaa753c9100d4d6bb4d86e9cffd76525b9bec1e238a967826bf7b3d071e28
-- can(), tenant_ids_with() and is_platform(): one permission contract for policies and SQL modules, over a roles list, a role and permission catalog, an authorization provider or the app's own functions (blocks.permissions.model).
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

grant usage on schema better_supabase to supabase_auth_admin;

-- Disabled tenants and users get no permissions and no membership claims
-- (blocks.permissions.disabled; with the managed organizations module, its
-- disabled_at and deleted_at columns).
create or replace function better_supabase.tenant_disabled(tenant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from "public"."organizations" t where t."id" = tenant_disabled.tenant and t."disabled_at" is null)
$$;

create or replace function better_supabase.user_disabled(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from "public"."profiles" u where u."id" = user_disabled.user_id and u."disabled_at" is null)
$$;

revoke execute on function better_supabase.tenant_disabled(text) from public, anon, authenticated;
revoke execute on function better_supabase.user_disabled(uuid) from public, anon, authenticated;
grant execute on function better_supabase.tenant_disabled(text) to service_role, supabase_auth_admin;
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
    when 'organizations:manage' then array['organizations.manage']::text[]
    when 'projects:delete' then array['projects.delete']::text[]
    when 'projects:list' then array['projects.list']::text[]
    when 'projects:read' then array['projects.read']::text[]
    when 'projects:update' then array['projects.update']::text[]
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
    when 'permissions.listRoles' then 'members.read'
    when 'permissions.setOverride' then 'roles.manage'
  end
$$;

-- The provider model: the authorization provider (PermDock) decides,
-- through authorization.functions in better-supabase.config.ts. Its caller
-- functions read auth.uid(), so member_can() and can_user() answer for
-- another user through its idsWithFor and isPlatformFor.
create or replace function better_supabase.member_can(member uuid, tenant text, permission text)
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
create or replace function better_supabase.member_can_while_deleting(member uuid, tenant text, permission text)
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
create or replace function better_supabase.member_permissions(member uuid, tenant text)
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
    then coalesce(array(select k from unnest(coalesce((array(select permdock.permitted_organization_permission_keys_for(member, tenant))), '{}'::text[])) as k where k = any(array['organizations.manage', 'projects.delete', 'projects.list', 'projects.read', 'projects.update']::text[])), '{}'::text[])
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
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(better_supabase.member_permissions(permission_claims.user_id, t.id::text))), '{}'::jsonb)
  from permdock.member_organization_ids_for(permission_claims.user_id) as t(id)
  where not better_supabase.user_disabled(permission_claims.user_id)
    and not better_supabase.tenant_disabled(t.id::text)
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

-- Whether member may assign role in tenant, for trusted SQL that acts later
-- for a stored user, such as accepting an invitation the inviter sent.
create or replace function better_supabase.can_assign_as(member uuid, tenant text, role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select member is not null
    and not better_supabase.user_disabled(member)
    and coalesce((permdock.permdock_can_assign_for(can_assign_as.member, can_assign_as.role, can_assign_as.tenant::text)), false)
$$;
revoke execute on function better_supabase.can_assign_as(uuid, text, text) from public, anon, authenticated;

create or replace function better_supabase.tenant_ids_with(permission text)
returns setof text
language sql
rows 1
stable
security definer
set search_path = ''
as $$
  select t.id::text from permdock.permitted_organization_ids_by_permission(tenant_ids_with.permission) as t(id)
  where better_supabase.cap_allows(tenant_ids_with.permission)
    and not better_supabase.user_disabled(auth.uid())
    and not better_supabase.tenant_disabled(t.id::text)
$$;

-- blocks.permissions.functions.canAssign, else authorization.functions.canAssign,
-- decides who assigns which role. Without either, only the service role
-- assigns roles.
create or replace function better_supabase.can_assign(tenant text, role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role' or coalesce((permdock.permdock_can_assign(can_assign.role, can_assign.tenant::text)), false)
$$;

-- The access contract. Policies and SQL modules call these, never a model's
-- tables, so the model can change without touching them. In a policy, use
-- the set, which runs once per statement and can use the tenant index:
--   using (organization_id in (select better_supabase.tenant_ids_with('invoices.read')))
-- can() with a column argument runs once per row, even inside (select ...);
-- keep it for checks on one row and inside functions.
create or replace function better_supabase.can(scope text, scope_id text, permission text)
returns boolean
language sql
stable
security definer
cost 1000
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
create or replace function better_supabase.can_user(member uuid, scope text, scope_id text, permission text)
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

-- { [tenant]: permission keys } for one tenant, the active one; {} without a
-- tenant or when the model can't answer.
create or replace function better_supabase.permission_claims(user_id uuid, tenant text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when permission_claims.tenant is null then '{}'::jsonb
    else coalesce(jsonb_strip_nulls(jsonb_build_object(permission_claims.tenant::text, to_jsonb(better_supabase.member_permissions(permission_claims.user_id, permission_claims.tenant)))), '{}'::jsonb)
  end
$$;

-- The caller's permission keys in a tenant, for client checks. With keys,
-- the ones can() grants: every model answers, including a provider and
-- delegated tokens. Without them, the keys the model lists for the member,
-- wildcards as granted (the custom model lists none).
create or replace function better_supabase.my_permissions(tenant text, keys text[] default null)
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
revoke execute on function better_supabase.can(text, text, text) from public;
grant execute on function better_supabase.can(text, text, text) to anon, authenticated, service_role;
revoke execute on function better_supabase.tenant_ids_with(text) from public;
grant execute on function better_supabase.tenant_ids_with(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.is_platform(text) from public;
grant execute on function better_supabase.is_platform(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.can_assign(text, text) from public;
grant execute on function better_supabase.can_assign(text, text) to anon, authenticated, service_role;
revoke execute on function better_supabase.my_permissions(text, text[]) from public;
grant execute on function better_supabase.my_permissions(text, text[]) to anon, authenticated, service_role;
revoke execute on function better_supabase.member_can(uuid, text, text) from public, anon, authenticated;
grant execute on function better_supabase.member_can(uuid, text, text) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.member_can_while_deleting(uuid, text, text) from public, anon, authenticated;
grant execute on function better_supabase.member_can_while_deleting(uuid, text, text) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.member_permissions(uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.member_permissions(uuid, text) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.platform_can(uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.platform_can(uuid, text) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.can_user(uuid, text, text, text) from public, anon, authenticated;
grant execute on function better_supabase.can_user(uuid, text, text, text) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.permission_claims(uuid) from public, anon, authenticated;
grant execute on function better_supabase.permission_claims(uuid) to service_role, supabase_auth_admin;
revoke execute on function better_supabase.permission_claims(uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.permission_claims(uuid, text) to service_role, supabase_auth_admin;

-- The permission claim: { [tenant id]: permission keys }, for the access
-- token hook when the app checks permissions from the token. Write the
-- active tenant only, and mark the claim truncated when it outgrows the
-- token budget, so readers ask the database instead:
--   declare
--     tenant text := event #>> '{claims,app_metadata,tenant_id}';
--     keys jsonb := better_supabase.permission_claims((event ->> 'user_id')::uuid, tenant::text);
--   begin
--     if octet_length(keys::text) > 2048 then
--       event := jsonb_set(event, '{claims,memberships_truncated}', 'true');
--       keys := '{}'::jsonb;
--     end if;
--     return jsonb_set(event, '{claims,permissions}', keys);
