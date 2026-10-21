-- better-supabase module: tenant (0.12.0)
-- @bs-module tenant@2 adopt
-- Memberships with roles, member_organization_ids() and has_organization_role() for RLS policies, and membership_claims() for the access token hook. Adopt an existing memberships table through blocks.tenant.
-- Managed by `better-supabase add`; re-running it overwrites this file.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create schema if not exists better_supabase;
grant usage on schema better_supabase to anon, authenticated, service_role;
grant usage on schema better_supabase to supabase_auth_admin;
set check_function_bodies = off;

-- Adopted: "public"."organization_memberships" belongs to the app (blocks.tenant.tables.memberships).

drop trigger if exists "bs_role_scope" on "public"."organization_memberships";
drop function if exists "better_supabase"."membership_role_scope"();


-- The tenant the server resolved (the better_supabase.tenant setting over Postgres,
-- the x-bs-tenant header over the Data API), then the `tenant_id` claim.
-- A tenant the caller isn't a member of counts as none.
create or replace function better_supabase.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m."organization_id"::text from "public"."organization_memberships" m where m."organization_id"::text = nullif(current_setting('better_supabase.tenant', true), '') and m."user_id" = auth.uid() limit 1),
    (select m."organization_id"::text from "public"."organization_memberships" m where m."organization_id"::text = nullif(current_setting('request.headers', true)::jsonb ->> 'x-bs-tenant', '') and m."user_id" = auth.uid() limit 1),
    (select m."organization_id"::text from "public"."organization_memberships" m where m."organization_id"::text = nullif(coalesce(auth.jwt() ->> 'tenant_id', auth.jwt() -> 'app_metadata' ->> 'tenant_id'), '') and m."user_id" = auth.uid() limit 1)
  )::uuid
$$;
revoke execute on function better_supabase.current_tenant_id() from public;
grant execute on function better_supabase.current_tenant_id() to anon, authenticated, service_role, supabase_auth_admin;

-- Policies compare against the set once per statement:
--   using (organization_id in (select better_supabase.member_organization_ids('{owner,admin}')))
-- has_organization_role(organization) answers for one organization, in functions and checks.
-- Prefer the access contract (better_supabase.can, tenant_ids_with) for
-- permission checks; these answer by role name.
-- Under the authorization provider, membership comes from its memberIds;
-- the memberships table only names roles.
create or replace function better_supabase.member_organization_ids(roles text[] default null)
returns setof uuid
language sql
rows 1
stable
security definer
set search_path = ''
as $$
  select p.id
  from permdock.member_organization_ids() as p(id)
  where member_organization_ids.roles is null
    and not better_supabase.user_disabled((select auth.uid()))
    and not better_supabase.tenant_disabled(p.id)
  union
  select m."organization_id"
  from "public"."organization_memberships" m
  where member_organization_ids.roles is not null
    and m."user_id" = (select auth.uid())
    and m."role" = any (member_organization_ids.roles)
    and not better_supabase.user_disabled(m."user_id")
    and not better_supabase.tenant_disabled(m."organization_id")
    and m."organization_id" in (select p.id from permdock.member_organization_ids() as p(id))
$$;

create or replace function better_supabase.has_organization_role(organization uuid, roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select has_organization_role.organization in (
    select better_supabase.member_organization_ids(has_organization_role.roles)
  )
$$;

-- The role of a user in a tenant, or null when they aren't a member.
create or replace function better_supabase.organization_member_role(organization uuid, member uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m."role" from "public"."organization_memberships" m where m."organization_id" = organization_member_role.organization and m."user_id" = organization_member_role.member and m."organization_id" in (select p.id from permdock.member_organization_ids_for(organization_member_role.member) as p(id))
$$;

revoke execute on function better_supabase.member_organization_ids(text[]) from public, anon;
revoke execute on function better_supabase.has_organization_role(uuid, text[]) from public, anon;
revoke execute on function better_supabase.organization_member_role(uuid, uuid) from public, anon, authenticated;
grant execute on function better_supabase.member_organization_ids(text[]) to authenticated, service_role;
grant execute on function better_supabase.has_organization_role(uuid, text[]) to authenticated, service_role;
grant execute on function better_supabase.organization_member_role(uuid, uuid) to service_role;

-- The memberships claim. `claimFormat: 'array'` (the default) is
-- [{ scope, id, roles }]; `'map'` is { [tenant id]: role }. When an
-- authorization provider's hook writes this claim, use its hook instead.
-- Otherwise call it from your custom access token hook:
--   return jsonb_set(event, '{claims,memberships}',
--     better_supabase.membership_claims((event ->> 'user_id')::uuid));
-- Disabled users and tenants (blocks.access.disabled) are left out.
create or replace function better_supabase.membership_claims(user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'scope', 'tenant',
      'id', m."organization_id",
      'roles', jsonb_build_array(m."role")
    ) order by m."created_at", m."organization_id"), '[]'::jsonb)
  from "public"."organization_memberships" m
  where m."user_id" = membership_claims.user_id
    and not better_supabase.user_disabled(membership_claims.user_id)
    and not better_supabase.tenant_disabled(m."organization_id")
$$;

revoke execute on function better_supabase.membership_claims(uuid) from public, anon, authenticated;
grant execute on function better_supabase.membership_claims(uuid) to service_role, supabase_auth_admin;
reset check_function_bodies;

create schema if not exists better_supabase;
create table if not exists better_supabase.modules (
  name text primary key,
  version integer not null,
  mode text not null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table better_supabase.modules enable row level security;
revoke all on better_supabase.modules from anon, authenticated;
grant select on better_supabase.modules to service_role;
