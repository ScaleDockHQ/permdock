-- better-supabase module: permissions
-- @bsb-block permissions@1 managed
-- @bsb-hash sha256:b0ddf093a650b28032c509478c9e29fad1b724f5a26098ea2875f62b44cd1f9c
-- can(), tenant_ids_with() and is_platform(): one permission contract for policies and SQL modules, over a roles list, a role and permission catalog, an authorization provider or the app's own functions (blocks.permissions.model).
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

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
  select not exists (select 1 from "public"."organizations" t where t."id" = tenant_disabled.tenant and t."status"::text in ('active'))
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

-- A granted key matches only itself; the provider honours no wildcards.
create or replace function better_supabase.permission_matches(granted text, wanted text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select granted = wanted
$$;

-- True for a user's own session and for no token at all. False for an API
-- key (api_key), an OAuth client (client_id) and an act chain (an agent, a
-- delegation, support or impersonation).
create or replace function better_supabase.interactive_session()
returns boolean
language sql
stable
set search_path = ''
as $$
  select auth.jwt() is null
    or (auth.jwt() -> 'api_key' is null
      and coalesce(auth.jwt() ->> 'client_id', '') = ''
      and auth.jwt() -> 'act' is null)
$$;

-- The permission keys only a signed-in user gets (the built-in
-- interactive-only operations, authorization.delegation.interactiveOnly and
-- blocks.permissions.interactiveOnly): cap_allows refuses them to every
-- other session, whatever its scopes.
create or replace function better_supabase.interactive_only(permission text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(permission = any (array['impersonation.start', 'organization.delete', 'organization.transfer_ownership', 'platform.invite', 'sso.manage']::text[]), false)
$$;

-- The roles only a signed-in user grants or takes away: the organization
-- owner role. can_assign refuses them to every other session.
create or replace function better_supabase.interactive_only_role(role text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(role = 'owner', false)
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
    when 'access_requests:create' then array['access_requests.create']::text[]
    when 'access_requests:emergency' then array['access_requests.emergency']::text[]
    when 'access_requests:manage' then array['access_requests.manage']::text[]
    when 'access_requests:read' then array['access_requests.read']::text[]
    when 'access_requests:review' then array['access_requests.review']::text[]
    when 'api_keys:manage' then array['api_keys.manage']::text[]
    when 'api_keys:own' then array['api_keys.own']::text[]
    when 'approvals:manage' then array['approvals.manage']::text[]
    when 'approvals:read' then array['approvals.read']::text[]
    when 'approvals:request' then array['approvals.request']::text[]
    when 'audit:read' then array['audit.read']::text[]
    when 'audit:revert' then array['audit.revert']::text[]
    when 'automations:manage' then array['automations.manage']::text[]
    when 'automations:publish' then array['automations.publish']::text[]
    when 'automations:read' then array['automations.read']::text[]
    when 'automations:write' then array['automations.write']::text[]
    when 'billing:read' then array['billing.read']::text[]
    when 'impersonation:read' then array['impersonation.read']::text[]
    when 'impersonation:revoke' then array['impersonation.revoke']::text[]
    when 'impersonation:start' then array['impersonation.start']::text[]
    when 'members:invite' then array['members.invite']::text[]
    when 'members:read' then array['members.read']::text[]
    when 'members:remove' then array['members.remove']::text[]
    when 'members:update_role' then array['members.update_role']::text[]
    when 'organization:delete' then array['organization.delete']::text[]
    when 'organization:transfer_ownership' then array['organization.transfer_ownership']::text[]
    when 'organization:update' then array['organization.update']::text[]
    when 'quotes:approve' then array['quotes.approve']::text[]
    when 'quotes:create' then array['quotes.create']::text[]
    when 'quotes:delete' then array['quotes.delete']::text[]
    when 'quotes:list' then array['quotes.list']::text[]
    when 'quotes:read' then array['quotes.read']::text[]
    when 'quotes:send' then array['quotes.send']::text[]
    when 'quotes:update' then array['quotes.update']::text[]
    when 'relations:manage' then array['relations.manage']::text[]
    when 'relations:read' then array['relations.read']::text[]
    when 'roles:manage' then array['roles.manage']::text[]
    when 'service_accounts:manage' then array['service_accounts.manage']::text[]
    when 'service_accounts:read' then array['service_accounts.read']::text[]
    when 'settings:manage' then array['settings.manage']::text[]
    when 'settings:read' then array['settings.read']::text[]
    when 'settings:update' then array['settings.update']::text[]
    when 'sso:manage' then array['sso.manage']::text[]
    when 'staff:list' then array['staff.list']::text[]
    when 'staff:read' then array['staff.read']::text[]
    when 'teams:manage' then array['teams.manage']::text[]
    when 'teams:read' then array['teams.read']::text[]
    when 'usage:read' then array['usage.read']::text[]
    when 'usage:record' then array['usage.record']::text[]
    else array[scope]
  end
$$;

-- False when the token is narrower than the permission: an interactive-only
-- key outside a user's own session, a permission cap (bsb_permission_cap)
-- without the key, an API key (api_key) or a delegated token whose scopes
-- don't map to it. An API key without scopes holds no permission. True
-- for every other token, the service role included.
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
    when better_supabase.interactive_only(cap_allows.permission)
      and not better_supabase.interactive_session() then false
    when jsonb_typeof(cap) = 'array'
      and not exists (
        select 1 from jsonb_array_elements_text(cap) c(key)
        where better_supabase.permission_matches(c.key, cap_allows.permission)
      ) then false
    when jsonb_typeof(jwt -> 'api_key') = 'object' then exists (
      select 1
      from jsonb_array_elements_text(case jsonb_typeof(jwt -> 'api_key' -> 'scopes')
          when 'array' then jwt -> 'api_key' -> 'scopes'
          else '[]'::jsonb
        end) s(scope)
      cross join lateral unnest(better_supabase.scope_permissions(s.scope)) k(key)
      where better_supabase.permission_matches(k.key, cap_allows.permission)
    )
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
    when 'access-requests.create' then 'access_requests.create'
    when 'access-requests.emergency' then 'access_requests.emergency'
    when 'access-requests.manage' then 'access_requests.manage'
    when 'access-requests.read' then 'access_requests.read'
    when 'access-requests.review' then 'access_requests.review'
    when 'api-keys.manage' then 'api_keys.manage'
    when 'api-keys.own' then 'api_keys.own'
    when 'approvals.manage' then 'approvals.manage'
    when 'approvals.read' then 'approvals.read'
    when 'approvals.request' then 'approvals.request'
    when 'audit.read' then 'audit.read'
    when 'audit.readAll' then 'audit.read'
    when 'audit.revert' then 'audit.revert'
    when 'automations.manage' then 'automations.manage'
    when 'automations.publish' then 'automations.publish'
    when 'automations.read' then 'automations.read'
    when 'automations.write' then 'automations.write'
    when 'impersonation.read' then 'impersonation.read'
    when 'impersonation.revoke' then 'impersonation.revoke'
    when 'impersonation.start' then 'impersonation.start'
    when 'invitations.invite' then 'members.invite'
    when 'invitations.invitePlatform' then 'platform.invite'
    when 'invitations.read' then 'members.invite'
    when 'invitations.revoke' then 'members.invite'
    when 'organizations.delete' then 'organization.delete'
    when 'organizations.listMembers' then 'members.read'
    when 'organizations.removeMember' then 'members.remove'
    when 'organizations.suspendMember' then 'members.remove'
    when 'organizations.transferOwnership' then 'organization.transfer_ownership'
    when 'organizations.update' then 'organization.update'
    when 'organizations.updateRole' then 'members.update_role'
    when 'permissions.explain' then 'members.read'
    when 'permissions.listRoles' then 'members.read'
    when 'permissions.setOverride' then 'roles.manage'
    when 'relations.manage' then 'relations.manage'
    when 'relations.read' then 'relations.read'
    when 'service-accounts.manage' then 'service_accounts.manage'
    when 'service-accounts.read' then 'service_accounts.read'
    when 'settings.platform' then 'settings.manage'
    when 'settings.read' then 'settings.read'
    when 'settings.update' then 'settings.update'
    when 'share-links.create' then 'quotes.update'
    when 'share-links.read' then 'quotes.read'
    when 'sso.manage' then 'sso.manage'
    when 'teams.manage' then 'teams.manage'
    when 'teams.read' then 'teams.read'
    when 'usage.read' then 'usage.read'
    when 'usage.record' then 'usage.record'
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
    then coalesce(array(select k from unnest(coalesce((array(select permdock.permitted_organization_permission_keys_for(member, tenant))), '{}'::text[])) as k where k = any(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.create', 'quotes.read', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[])), '{}'::text[])
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
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role' or ((better_supabase.interactive_session() or not better_supabase.interactive_only_role(can_assign.role)) and coalesce((false), false))
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

-- { [tenant]: permission keys } for one tenant, the active one; {} without a
-- tenant or when the model can't answer.
create or replace function better_supabase.permission_claims(user_id uuid, tenant uuid)
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

-- The records the caller reaches as a guest for action (read, comment or
-- upload). A guest is not a member: can() stays false for them, and policies
-- add this set through ctx.scope.guest.
create or replace function better_supabase.portal_subjects(action text)
returns table (tenant text, subject_type text, subject_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select null::text, null::text, null::text where false
$$;
revoke execute on function better_supabase.portal_subjects(text) from public, anon;
grant execute on function better_supabase.portal_subjects(text) to authenticated, service_role;

-- The parties (a company, a person) the caller acts for as a guest, for
-- portal reads such as a customer's own invoices.
create or replace function better_supabase.portal_parties()
returns table (tenant text, party_type text, party_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select g.tenant::text, g.party_type::text, g.party_id::text from (select m.organization_id::text, 'customer', m.customer_id::text from public.contacts m where m.customer_id in (select permdock.member_customer_ids())) as g(tenant, party_type, party_id)
$$;
revoke execute on function better_supabase.portal_parties() from public, anon;
grant execute on function better_supabase.portal_parties() to authenticated, service_role;

revoke execute on function better_supabase.permission_matches(text, text) from public;
grant execute on function better_supabase.permission_matches(text, text) to anon, authenticated, service_role;
revoke execute on function better_supabase.scope_permissions(text) from public;
grant execute on function better_supabase.scope_permissions(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.cap_allows(text) from public;
grant execute on function better_supabase.cap_allows(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.interactive_session() from public;
grant execute on function better_supabase.interactive_session() to anon, authenticated, service_role;
revoke execute on function better_supabase.interactive_only(text) from public;
grant execute on function better_supabase.interactive_only(text) to anon, authenticated, service_role;
revoke execute on function better_supabase.interactive_only_role(text) from public;
grant execute on function better_supabase.interactive_only_role(text) to anon, authenticated, service_role;
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
revoke execute on function better_supabase.permission_claims(uuid, uuid) from public, anon, authenticated;
grant execute on function better_supabase.permission_claims(uuid, uuid) to service_role, supabase_auth_admin;

-- The permission claim: { [tenant id]: permission keys }, for the access
-- token hook when the app checks permissions from the token. Write the
-- active tenant only, and mark the claim truncated when it outgrows the
-- token budget, so readers ask the database instead:
--   declare
--     tenant text := event #>> '{claims,app_metadata,tenant_id}';
--     keys jsonb := better_supabase.permission_claims((event ->> 'user_id')::uuid, tenant::uuid);
--   begin
--     if octet_length(keys::text) > 2048 then
--       event := jsonb_set(event, '{claims,memberships_truncated}', 'true');
--       keys := '{}'::jsonb;
--     end if;
--     return jsonb_set(event, '{claims,permissions}', keys);
