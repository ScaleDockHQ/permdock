-- better-supabase's tenant block, adopting public.organization_memberships, and its share-links block;
-- PermDock's approval requests, out-of-office covers (rls.approvals.delegations), the guest role
-- and the anon policy share-link capabilities read quotes through (rls.capabilities).

-- better-supabase's tenant block adopts this view (blocks.tenant.tables.memberships), so
-- share links and the other tenant blocks read PermDock's memberships instead of a second table.
-- A user holding two roles in one organization appears once, with the earliest.
create view public.organization_memberships
  with (security_invoker = true)
as
select distinct on (scope_id, user_id)
  scope_id as organization_id,
  user_id,
  role,
  created_at
from public.memberships
where scope = 'organization'
order by scope_id, user_id, created_at, role;

revoke all on public.organization_memberships from anon, authenticated;

create or replace function better_supabase.operation_permission(op text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case op
    when 'audit.revert' then 'audit.revert'
    when 'audit.view' then 'audit.view'
    when 'audit.viewAll' then 'audit.view'
    when 'share-links.create' then 'quotes.update'
    when 'share-links.read' then 'quotes.read'
  end
$$;

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

-- better-supabase module: share-links (0.12.0)
-- @bs-module share-links@1 managed
-- Hashed share links, view counts and per-user state. The token is returned once. Resolving a link hashes the token the caller presents, so a stored plaintext token keeps working after it is hashed.
-- Managed by `better-supabase add`; re-running it overwrites this file.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create or replace function better_supabase.actor_may_write()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when auth.jwt() is null then true
    when auth.jwt() -> 'act' ->> 'kind' = 'support'
      then coalesce(auth.jwt() -> 'act' -> 'read_only' = 'false'::jsonb, false)
    when auth.jwt() -> 'act' ->> 'kind' = 'agent'
      then coalesce(auth.jwt() -> 'act' -> 'read_only', 'false'::jsonb) = 'false'::jsonb
    when auth.jwt() -> 'act' ->> 'kind' is not null then false
    when auth.jwt() -> 'act' ->> 'session_id' is not null
      and auth.jwt() -> 'act' ->> 'kind' is null then false
    else true
  end
$$;
revoke execute on function better_supabase.actor_may_write() from public;
grant execute on function better_supabase.actor_may_write() to anon, authenticated, service_role;

create or replace function better_supabase.raise_actor_readonly()
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
end;
$$;
revoke execute on function better_supabase.raise_actor_readonly() from public;
grant execute on function better_supabase.raise_actor_readonly() to anon, authenticated, service_role;
create schema if not exists better_supabase;
grant usage on schema better_supabase to anon, authenticated, service_role;
create table if not exists "better_supabase"."share_links" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "subject_type" text not null,
  "subject_id" text not null,
  "token_hash" text not null unique,
  "role" text not null default 'view',
  "version" integer not null default 1,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "max_uses" integer,
  "created_by" uuid,
  "leaf_id" text
);
alter table "better_supabase"."share_links" add column if not exists "version_id" uuid;
alter table "better_supabase"."share_links" add column if not exists "use_count" integer not null default 0;
alter table "better_supabase"."share_links" enable row level security;
revoke all on "better_supabase"."share_links" from anon, authenticated;
grant select on "better_supabase"."share_links" to authenticated;
grant all on "better_supabase"."share_links" to service_role;
create index if not exists "share_links_subject_idx" on "better_supabase"."share_links" ("tenant_id", "subject_type", "subject_id");
create table if not exists "better_supabase"."subject_views" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "subject_type" text not null,
  "subject_id" text not null,
  "version" integer not null default 1,
  "viewer_kind" text not null,
  "viewer" text,
  "first_viewed_at" timestamptz not null default now(),
  "last_viewed_at" timestamptz not null default now(),
  "view_count" integer not null default 1,
  unique ("tenant_id", "subject_type", "subject_id", "viewer_kind", "viewer")
);
alter table "better_supabase"."subject_views" enable row level security;
revoke all on "better_supabase"."subject_views" from anon, authenticated;
grant select on "better_supabase"."subject_views" to authenticated;
grant all on "better_supabase"."subject_views" to service_role;

create table if not exists "better_supabase"."subject_user_state" (
  "subject_type" text not null,
  "subject_id" text not null,
  "user_id" uuid not null,
  "starred_at" timestamptz,
  "last_opened_at" timestamptz,
  primary key ("subject_type", "subject_id", "user_id")
);
alter table "better_supabase"."subject_user_state" enable row level security;
revoke all on "better_supabase"."subject_user_state" from anon, authenticated;
grant select on "better_supabase"."subject_user_state" to authenticated;
grant all on "better_supabase"."subject_user_state" to service_role;


drop function if exists "better_supabase"."create_share_link"(uuid, text, text, text);
drop function if exists "better_supabase"."create_share_link"(uuid, text, text, text, uuid);
drop function if exists "better_supabase"."create_share_link"(uuid, text, text, text, uuid, timestamptz);
drop function if exists "better_supabase"."create_share_link"(uuid, text, text, text, uuid, timestamptz, jsonb);
-- fields: the extra columns (blocks.share-links.options.extraColumns) to set.
drop function if exists "better_supabase"."create_share_link"(uuid, text, text, text, uuid, timestamptz, integer, jsonb);
create or replace function "better_supabase"."create_share_link"(tenant uuid, subject_type text, subject_id text, role text, version_id uuid default null, expires_at timestamptz default null, max_uses integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_id uuid;
  v_subject_ok boolean;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (auth.role() = 'service_role' or coalesce(better_supabase.can('tenant', create_share_link.tenant, 'quotes.update'), false)) then
    raise exception 'not allowed to share' using errcode = '42501', hint = 'SHARE_FORBIDDEN';
  end if;
  if create_share_link.expires_at is not null and create_share_link.expires_at <= now() then
    raise exception 'expires_at must be in the future' using errcode = '22023', hint = 'SHARE_EXPIRY_INVALID';
  end if;
  if create_share_link.max_uses is not null and create_share_link.max_uses < 1 then
    raise exception 'max_uses must be at least 1' using errcode = '22023', hint = 'SHARE_MAX_USES_INVALID';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'this subject type can''t be shared' using errcode = '22023', hint = 'SHARE_SUBJECT_UNKNOWN';
  end if;
  if create_share_link.version_id is not null then
    raise exception 'install the versions module to share a version' using errcode = '22023', hint = 'SHARE_VERSION_INVALID';
  end if;
  insert into "better_supabase"."share_links" ("tenant_id", "subject_type", "subject_id", "token_hash", "role", "expires_at", "max_uses", "created_by", "version_id")
  values (create_share_link.tenant, create_share_link.subject_type, create_share_link.subject_id, encode(extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex'), coalesce(create_share_link.role, 'view'), create_share_link.expires_at, create_share_link.max_uses, auth.uid(), create_share_link.version_id)
  returning "id" into v_id;
  null;
  return jsonb_build_object('id', v_id, 'token', v_token);
end;
$$;
revoke execute on function "better_supabase"."create_share_link"(uuid, text, text, text, uuid, timestamptz, integer) from public, anon;
grant execute on function "better_supabase"."create_share_link"(uuid, text, text, text, uuid, timestamptz, integer) to authenticated, service_role;

-- The link's creator, or a caller who may create links in its tenant, may
-- revoke it. Anyone else gets SHARE_NOT_FOUND, so ids can't be probed.
create or replace function "better_supabase"."revoke_share_link"(id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tenant uuid;
  v_creator uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select "tenant_id", "created_by" into v_tenant, v_creator
  from "better_supabase"."share_links"
  where "id" = revoke_share_link.id and "revoked_at" is null
  for update;
  if not found or not (
    auth.role() = 'service_role'
    or (v_creator is not null and v_creator = auth.uid())
    or coalesce(better_supabase.can('tenant', v_tenant, 'quotes.update'), false)
  ) then
    raise exception 'share link not found' using errcode = 'P0002', hint = 'SHARE_NOT_FOUND';
  end if;
  update "better_supabase"."share_links" set "revoked_at" = now()
  where "id" = revoke_share_link.id;
  null;
  return true;
end;
$$;
revoke execute on function "better_supabase"."revoke_share_link"(uuid) from public, anon;
grant execute on function "better_supabase"."revoke_share_link"(uuid) to authenticated, service_role;

-- Each resolve counts one use, so a link with max_uses stops resolving once
-- it is spent. The row lock keeps two concurrent resolves from both taking
-- the last use.
create or replace function "better_supabase"."resolve_share_link"(token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link "better_supabase"."share_links"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_link
  from "better_supabase"."share_links" l
  where l."token_hash" = encode(extensions.digest(convert_to(resolve_share_link.token, 'utf8'), 'sha256'), 'hex')
    and l."revoked_at" is null
    and (l."expires_at" is null or l."expires_at" > now())
    and (l."max_uses" is null or l."use_count" < l."max_uses")
  for update;
  if not found then
    return null;
  end if;
  update "better_supabase"."share_links" set "use_count" = "use_count" + 1
  where "id" = v_link."id";
  return jsonb_build_object('id', v_link."id", 'organizationId', v_link."tenant_id", 'subjectType', v_link."subject_type", 'subjectId', v_link."subject_id", 'role', v_link."role", 'versionId', v_link."version_id", 'expiresAt', v_link."expires_at", 'maxUses', v_link."max_uses");
end;
$$;
revoke all on function "better_supabase"."resolve_share_link"(text) from public, anon, authenticated;
grant execute on function "better_supabase"."resolve_share_link"(text) to anon, authenticated, service_role;

create or replace function "better_supabase"."record_view"(tenant uuid, subject_type text, subject_id text, viewer_kind text, viewer text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (auth.role() = 'service_role' or record_view.tenant in (select better_supabase.member_organization_ids())) then
    raise exception 'not a member of this organization' using errcode = '42501', hint = 'SHARE_FORBIDDEN';
  end if;
  insert into "better_supabase"."subject_views" ("tenant_id", "subject_type", "subject_id", "viewer_kind", "viewer")
  values (record_view.tenant, record_view.subject_type, record_view.subject_id, record_view.viewer_kind, record_view.viewer)
  on conflict ("tenant_id", "subject_type", "subject_id", "viewer_kind", "viewer")
  do update set "last_viewed_at" = now(), "view_count" = "better_supabase"."subject_views"."view_count" + 1;
  null;
  return true;
end;
$$;
revoke execute on function "better_supabase"."record_view"(uuid, text, text, text, text) from public, anon;
grant execute on function "better_supabase"."record_view"(uuid, text, text, text, text) to authenticated, service_role;

create or replace function "better_supabase"."list_share_links"(subject_type text, subject_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', l."id", 'role', l."role", 'expiresAt', l."expires_at", 'revokedAt', l."revoked_at")), '[]'::jsonb)
  from "better_supabase"."share_links" l
  where l."subject_type" = list_share_links.subject_type
    and l."subject_id" = list_share_links.subject_id
    and (
      auth.role() = 'service_role'
      or l."created_by" = (select auth.uid())
      or l."tenant_id" in (select better_supabase.tenant_ids_with('quotes.read'))
    )
$$;
revoke execute on function "better_supabase"."list_share_links"(text, text) from public, anon;
grant execute on function "better_supabase"."list_share_links"(text, text) to authenticated, service_role;

create or replace function "better_supabase"."set_user_state"(subject_type text, subject_id text, starred boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  insert into "better_supabase"."subject_user_state" ("subject_type", "subject_id", "user_id", "starred_at", "last_opened_at")
  values (set_user_state.subject_type, set_user_state.subject_id, auth.uid(), case when set_user_state.starred then now() else null end, now())
  on conflict ("subject_type", "subject_id", "user_id")
  do update set "starred_at" = excluded."starred_at", "last_opened_at" = now();
  return true;
end;
$$;
revoke execute on function "better_supabase"."set_user_state"(text, text, boolean) from public, anon;
grant execute on function "better_supabase"."set_user_state"(text, text, boolean) to authenticated, service_role;

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

create or replace view "permdock".permdock_ceiling with (security_invoker = true) as
select rp.scope, rp.role, rp.permission, rp.grant_key, rp.effect
from "permdock".role_permissions rp
where rp.role = any(array['guest', 'member', 'owner']::text[])
  and exists (
    select 1 from "permdock".role_permissions a
    where a.role = rp.role
      and a.permission = rp.permission
      and a.scope = rp.scope
      and a.effect = 'allow'
  );
revoke all on table "permdock".permdock_ceiling from anon, authenticated, public;

-- one custom role: included ceiling keys and same-scope denies, plus every ceiling key of an allowed permission, minus denied permissions

create or replace function "permdock".permdock_has(p_grant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from "permdock".user_roles ur
    join "permdock".role_permissions rp on rp.role = ur.role::text
    where ur.user_id = (select "permdock".permdock_user_id())
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = (select "permdock".permdock_user_id())
      and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
      and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
      'global'
    ))
  )
$$;
revoke execute on function "permdock".permdock_has(text) from public, anon;
grant execute on function "permdock".permdock_has(text) to authenticated;

-- link capabilities: the capability claim exchangeCapability mints (role anon, short-lived)

create or replace function "permdock".permdock_capability_ids(p_resource text, p_role text, p_permission text)
returns setof text
language sql
stable
set search_path = ''
as $$
  select c -> 'on' ->> 'id'
  from (select ((select auth.jwt()) -> 'capability') as c) capability
  where jsonb_typeof(c) = 'object'
    and c ->> 'v' = '1'
    and c ->> 'holder' = 'link'
    and c -> 'on' ->> 'resource' = p_resource
    and jsonb_typeof(c -> 'roles') = 'array'
    and c -> 'roles' @> jsonb_build_array(p_role)
    and (c -> 'permissions' is null or c -> 'permissions' @> jsonb_build_array(p_permission))
    and jsonb_typeof(c -> 'expires_at') = 'number'
    and (c ->> 'expires_at')::numeric > extract(epoch from now())
$$;
revoke execute on function "permdock".permdock_capability_ids(text, text, text) from public;
grant execute on function "permdock".permdock_capability_ids(text, text, text) to anon, authenticated;

create or replace function "permdock".permitted_organization_ids(p_grant text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'organization'
    ));
end;
$$;
revoke execute on function "permdock".permitted_organization_ids(text) from public, anon;
grant execute on function "permdock".permitted_organization_ids(text) to authenticated;

create or replace function "permdock".permitted_customer_ids(p_grant text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
  v_user_1 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'customer'
    ));
end;
$$;
revoke execute on function "permdock".permitted_customer_ids(text) from public, anon;
grant execute on function "permdock".permitted_customer_ids(text) to authenticated;

create or replace function "permdock".permdock_has_for(p_user uuid, p_grant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from "permdock".user_roles ur
    join "permdock".role_permissions rp on rp.role = ur.role::text
    where ur.user_id = p_user
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = p_user
      and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
      and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
      'global'
    ))
  )
$$;
revoke execute on function "permdock".permdock_has_for(uuid, text) from public, anon, authenticated;

create or replace function "permdock".permitted_organization_ids_for(p_user uuid, p_grant text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
begin
  return query
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
  union
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'organization'
    ));
end;
$$;
revoke execute on function "permdock".permitted_organization_ids_for(uuid, text) from public, anon, authenticated;

create or replace function "permdock".permitted_customer_ids_for(p_user uuid, p_grant text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
  v_user_1 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and rp.scope = 'customer'
  union
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'customer'
    ));
end;
$$;
revoke execute on function "permdock".permitted_customer_ids_for(uuid, text) from public, anon, authenticated;

-- custom-role writes: the permission keys of a definition the caller may not hand out in the tenant, as assignablePermissions computes them

create or replace function "permdock".permdock_custom_role_shape(p_tenant uuid, p_scope text, p_scope_id text, p_role text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_scope = 'global' then
    if p_tenant is not null or p_scope_id is not null then
      raise exception using
        errcode = '22023',
        message = 'permdock: a platform custom role has no tenant or instance',
        hint = 'unknown-scope';
    end if;
  elsif not (p_scope = any(array['organization', 'customer']::text[])) then
    raise exception using
      errcode = '22023',
      message = 'permdock: custom roles are held at a scope of a tenant or at global, not ' || coalesce(p_scope, 'null'),
      hint = 'unknown-scope';
  elsif p_tenant is null and p_scope_id is not null then
    raise exception using
      errcode = '22023',
      message = 'permdock: a shared custom role has no instance',
      hint = 'unknown-scope';
  end if;
  if coalesce(p_role, '') = '' or p_role = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(p_role, 'null') || ' is not a custom role name',
      hint = 'declared-role';
  end if;
end;
$$;
revoke execute on function "permdock".permdock_custom_role_shape(uuid, text, text, text) from public, anon, authenticated;

-- a custom role the caller may change: membership of the tenant or the instance (a platform role, or a caller holding a manageRoles permission through a global role, needs none), and authority over the stored definition

create or replace function "permdock".permdock_custom_role_entries(p_scope text, p_allow text[], p_deny text[], p_include text[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_entry text;
  v_key text;
  v_problem text;
begin
  foreach v_entry in array coalesce(p_allow, '{}'::text[]) loop
    v_key := v_entry;
    v_problem := "permdock".permdock_custom_role_entry_problem(p_scope, v_entry);
    if v_problem = 'unknown-permission' then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_entry || ' is not a declared permission',
        hint = 'unknown-permission';
    end if;
    if v_problem = 'outside-ceiling' then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_key || ' is outside the ceiling of ' || p_scope,
        hint = 'outside-ceiling';
    end if;
  end loop;
  foreach v_entry in array coalesce(p_deny, '{}'::text[]) loop
    if not (v_entry = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'staff.list', 'staff.read']::text[])) then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_entry || ' is not a declared permission',
        hint = 'unknown-permission';
    end if;
  end loop;
  foreach v_entry in array coalesce(p_include, '{}'::text[]) loop
    if not (v_entry = any(array['contact', 'guest', 'member', 'owner']::text[])) then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_entry || ' is not a declared role',
        hint = 'unknown-role';
    end if;
  end loop;
  select string_agg(distinct rp.permission, ', ') into v_key
  from "permdock".role_permissions rp
  where rp.role = any(coalesce(p_include, '{}'::text[]))
    and rp.effect = 'allow'
    and not exists (
      select 1 from "permdock".permdock_ceiling c
      where c.scope = p_scope and c.effect = 'allow' and c.permission = rp.permission
    );
  if v_key is not null then
    raise exception using
      errcode = '22023',
      message = 'permdock: an included role allows ' || v_key || ', outside the ceiling of ' || p_scope,
      hint = 'outside-ceiling';
  end if;
end;
$$;
revoke execute on function "permdock".permdock_custom_role_entries(text, text[], text[], text[]) from public, anon, authenticated;

-- save a custom role: replace its grants and includes after checking each entry against the ceiling and the caller's own permissions

create or replace function "permdock".permdock_rename_custom_role_grants(p_tenant uuid, p_scope text, p_scope_id text, p_from text, p_to text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform "permdock".permdock_custom_role_guard(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role',
      hint = 'name-taken';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name',
      hint = 'declared-role';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' already has grants',
      hint = 'role-exists';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_from;
end;
$$;
revoke execute on function "permdock".permdock_rename_custom_role_grants(uuid, text, text, text, text) from public, anon;
grant execute on function "permdock".permdock_rename_custom_role_grants(uuid, text, text, text, text) to authenticated;

-- delete a custom role: remove its grants and includes

create or replace function "permdock".permdock_trusted_rename_custom_role_grants(p_tenant uuid, p_scope text, p_scope_id text, p_from text, p_to text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role',
      hint = 'name-taken';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name',
      hint = 'declared-role';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' already has grants',
      hint = 'role-exists';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_from;
end;
$$;
revoke execute on function "permdock".permdock_trusted_rename_custom_role_grants(uuid, text, text, text, text) from public, anon, authenticated;

-- delete a custom role for a trusted caller

create or replace function "permdock".permdock_replace_custom_role_grants_by_id(p_role_id "public"."roles"."id"%type, p_permissions text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_scope text;
  v_scope_id text;
  v_key text;
  v_skipped boolean;
  v_deny text[];
  v_include text[];
begin
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'organization' end, null::text, r."key"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null'),
      hint = 'unknown-role';
  end if;
  if v_skipped or v_key = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role',
      hint = 'declared-role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key;
  perform "permdock".permdock_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "source" => 'permdock');
end;
$$;
revoke execute on function "permdock".permdock_replace_custom_role_grants_by_id("public"."roles"."id"%type, text[]) from public, anon;
grant execute on function "permdock".permdock_replace_custom_role_grants_by_id("public"."roles"."id"%type, text[]) to authenticated;

-- save a custom role by its row id for a trusted caller: the definition checks without the caller checks

create or replace function "permdock".permdock_trusted_replace_custom_role_grants_by_id(p_role_id "public"."roles"."id"%type, p_permissions text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_scope text;
  v_scope_id text;
  v_key text;
  v_skipped boolean;
  v_deny text[];
  v_include text[];
begin
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'organization' end, null::text, r."key"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null'),
      hint = 'unknown-role';
  end if;
  if v_skipped or v_key = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role',
      hint = 'declared-role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key;
  perform "permdock".permdock_trusted_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "source" => 'permdock');
end;
$$;
revoke execute on function "permdock".permdock_trusted_replace_custom_role_grants_by_id("public"."roles"."id"%type, text[]) from public, anon, authenticated;

-- the declared allow keys of custom roles by their row ids as text, for a trusted reader; with p_tenant, an id of another tenant is refused

create or replace function "permdock".permdock_trusted_role_permissions_by_id(p_role_ids text[], p_tenant uuid default null)
returns table (role_id text, permission text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_tenant is not null and exists (
    select 1 from "public"."roles" r
    where r."id"::text = any(p_role_ids) and r."organization_id"::uuid is distinct from p_tenant
  ) then
    raise exception using
      errcode = '42501',
      message = 'permdock: a role id belongs to another tenant than ' || p_tenant::text,
      hint = 'not-member';
  end if;
  return query
  select distinct v.role_id, c.permission
  from (
    select r."id"::text as role_id, r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'organization' end as scope, null::text as scope_id, r."key"::text as role
    from "public"."roles" r
    where r."id"::text = any(p_role_ids)
      and not (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
      and not (r."key"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ) v
  join "permdock".custom_role_permissions c
    on c.tenant_id is not distinct from v.tenant_id
    and c.scope = v.scope
    and c.scope_id is not distinct from v.scope_id
    and c.role = v.role
  where c.effect = 'allow'
    and c.permission = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'staff.list', 'staff.read']::text[])
  order by 1, 2;
end;
$$;
revoke execute on function "permdock".permdock_trusted_role_permissions_by_id(text[], uuid) from public, anon, authenticated;
grant usage on schema "permdock" to "service_role";
grant execute on function "permdock".permdock_trusted_role_permissions_by_id(text[], uuid) to "service_role";

-- the application's roles table: a tenant row cannot take the name of a declared or a shared role

create or replace function "permdock".permdock_custom_role_name_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new."organization_id"::uuid is null or coalesce(new."is_system", false) then
    return new;
  end if;
  if new."key"::text = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || new."key"::text || ' is a declared role',
      hint = 'declared-role';
  end if;
  if "permdock".permdock_is_shared_role(case when new."organization_id"::uuid is null then 'global' else 'organization' end, new."key"::text) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || new."key"::text || ' is a shared role',
      hint = 'name-taken';
  end if;
  return new;
end;
$$;
revoke execute on function "permdock".permdock_custom_role_name_guard() from public, anon, authenticated;

create or replace function "permdock".permdock_role_permissions(p_role text, p_scope text, p_tenant uuid default null, p_scope_id text default null)
returns table (permission text, effect text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_role = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    return query
  select distinct rp.permission, rp.effect
  from "permdock".role_permissions rp
  where rp.role = p_role and rp.scope = p_scope
  order by 1, 2;
    return;
  end if;
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '' and (
    false
    or (p_scope <> 'global' and p_tenant is null and p_scope_id is null)
    or (p_scope <> 'global' and (p_tenant::text in (select x::text from "permdock".member_organization_ids() x)
      or (case p_scope when 'organization' then false when 'customer' then p_scope_id in (select x::text from "permdock".member_customer_ids() x) else false end)))
  )) then
    raise exception using
      errcode = '42501',
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform'),
      hint = 'not-member';
  end if;
  return query
  select distinct rp.permission, rp.effect
  from "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role),
    p_scope
  ) k(grant_key)
  join "permdock".role_permissions rp on rp.grant_key = k.grant_key and rp.scope = p_scope
  order by 1, 2;
end;
$$;
revoke execute on function "permdock".permdock_role_permissions(text, text, uuid, text) from public, anon;
grant execute on function "permdock".permdock_role_permissions(text, text, uuid, text) to authenticated;

create or replace function "permdock".permdock_trusted_role_permissions(p_role text, p_scope text, p_tenant uuid default null, p_scope_id text default null)
returns table (permission text, effect text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_role = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    return query
  select distinct rp.permission, rp.effect
  from "permdock".role_permissions rp
  where rp.role = p_role and rp.scope = p_scope
  order by 1, 2;
    return;
  end if;
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  return query
  select distinct rp.permission, rp.effect
  from "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role),
    p_scope
  ) k(grant_key)
  join "permdock".role_permissions rp on rp.grant_key = k.grant_key and rp.scope = p_scope
  order by 1, 2;
end;
$$;
revoke execute on function "permdock".permdock_trusted_role_permissions(text, text, uuid, text) from public, anon, authenticated;
grant usage on schema "permdock" to "service_role";
grant execute on function "permdock".permdock_trusted_role_permissions(text, text, uuid, text) to "service_role";

-- the grant keys a permission key reaches on one scope: its unconditional allows, with p_effect 'deny' every deny, and with 'conditioned-allow' or 'conditioned-deny' the allows or denies that carry a row condition

create or replace function "permdock".permitted_organization_permission_keys(p_id uuid)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = (select "permdock".permdock_user_id())
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
revoke execute on function "permdock".permitted_organization_permission_keys(uuid) from public, anon;
grant execute on function "permdock".permitted_organization_permission_keys(uuid) to authenticated;

create or replace function "permdock".permitted_organization_permission_keys(p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = (select "permdock".permdock_user_id())
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
revoke execute on function "permdock".permitted_organization_permission_keys(uuid, text[]) from public, anon;
grant execute on function "permdock".permitted_organization_permission_keys(uuid, text[]) to authenticated;

-- with p_conditioned true, also the instances a conditioned allow reaches, minus only unconditional denies: the caller applies the row condition

create or replace function "permdock".permitted_customer_permission_keys(p_id uuid)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
  v_user_1 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = (select "permdock".permdock_user_id())
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
revoke execute on function "permdock".permitted_customer_permission_keys(uuid) from public, anon;
grant execute on function "permdock".permitted_customer_permission_keys(uuid) to authenticated;

create or replace function "permdock".permitted_customer_permission_keys(p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
  v_user_1 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = (select "permdock".permdock_user_id())
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
revoke execute on function "permdock".permitted_customer_permission_keys(uuid, text[]) from public, anon;
grant execute on function "permdock".permitted_customer_permission_keys(uuid, text[]) to authenticated;

-- with p_conditioned true, also the instances a conditioned allow reaches, minus only unconditional denies: the caller applies the row condition

create or replace function "permdock".permitted_organization_permission_keys_for(p_user uuid, p_id uuid)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = p_user
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
revoke execute on function "permdock".permitted_organization_permission_keys_for(uuid, uuid) from public, anon, authenticated;

create or replace function "permdock".permitted_organization_permission_keys_for(p_user uuid, p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = p_user
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
revoke execute on function "permdock".permitted_organization_permission_keys_for(uuid, uuid, text[]) from public, anon, authenticated;

create or replace function "permdock".permitted_customer_permission_keys_for(p_user uuid, p_id uuid)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
  v_user_1 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = p_user
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
revoke execute on function "permdock".permitted_customer_permission_keys_for(uuid, uuid) from public, anon, authenticated;

create or replace function "permdock".permitted_customer_permission_keys_for(p_user uuid, p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
  v_user_1 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = p_user
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
revoke execute on function "permdock".permitted_customer_permission_keys_for(uuid, uuid, text[]) from public, anon, authenticated;

-- the users who hold a permission on one organization: its members and the global-role holders for whom the _for helpers answer; no client role may execute it

create or replace function "permdock".permdock_actor_may_write()
returns boolean
language sql
stable
set search_path = ''
as $$
  select (not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = any(array['support', 'impersonation']::text[]) or ((((select auth.jwt()) -> 'act') ->> 'kind') is null and ((select auth.jwt()) -> 'act') ? 'session_id'), false) or coalesce((((select auth.jwt()) -> 'act') ->> 'read_only') = 'false', false)) and not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = 'agent' and (((select auth.jwt()) -> 'act') ->> 'read_only') = 'true', false)
$$;
revoke execute on function "permdock".permdock_actor_may_write() from public, anon;
grant execute on function "permdock".permdock_actor_may_write() to authenticated;

-- approval store: ApprovalRequest bodies, opened, resolved and consumed through the functions below; supabaseApprovalStore calls them

create table if not exists "permdock".approval_requests (
  token text primary key,
  body jsonb not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'expired')),
  tenant text,
  principal_id text,
  actor_id text,
  session text,
  approvals integer not null default 0,
  created_at text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists "approval_requests_page" on "permdock".approval_requests (created_at collate "C", token collate "C");

create index if not exists "approval_requests_pending" on "permdock".approval_requests (status, expires_at);
alter table "permdock".approval_requests enable row level security;
revoke all on table "permdock".approval_requests from anon, authenticated, public;

-- open a request; a repeated ask keeps the open record and replaces only an expired one

create or replace function "permdock".permdock_approval_open(p_request jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into "permdock".approval_requests as a (token, body, status, tenant, principal_id, actor_id, session, approvals, created_at, expires_at, consumed_at)
  values (
    p_request ->> 'token',
    p_request,
    p_request ->> 'status',
    p_request #>> '{subject,principal,tenant}',
    p_request #>> '{subject,principal,id}',
    p_request #>> '{subject,actor,id}',
    p_request #>> '{subject,session}',
    coalesce(jsonb_array_length(p_request -> 'approvals'), 0),
    p_request ->> 'createdAt',
    (p_request ->> 'expiresAt')::timestamptz,
    (p_request ->> 'consumedAt')::timestamptz
  )
  on conflict (token) do update
    set body = excluded.body, status = excluded.status, tenant = excluded.tenant,
      principal_id = excluded.principal_id, actor_id = excluded.actor_id, session = excluded.session,
      approvals = excluded.approvals, created_at = excluded.created_at,
      expires_at = excluded.expires_at, consumed_at = excluded.consumed_at
    where a.status = 'expired' or a.expires_at <= now()
$$;
revoke execute on function "permdock".permdock_approval_open(jsonb) from public, anon, authenticated;

create or replace function "permdock".permdock_approval_get(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select a.body from "permdock".approval_requests a where a.token = p_token
$$;
revoke execute on function "permdock".permdock_approval_get(text) from public, anon, authenticated;

-- write a verdict over the record it was computed from: still pending, unexpired, with p_seen approvals

create or replace function "permdock".permdock_approval_resolve(p_token text, p_next jsonb, p_seen integer)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  update "permdock".approval_requests a
  set body = p_next,
    status = p_next ->> 'status',
    approvals = coalesce(jsonb_array_length(p_next -> 'approvals'), 0)
  where a.token = p_token
    and a.status = 'pending'
    and a.expires_at > now()
    and a.approvals = p_seen
  returning a.body
$$;
revoke execute on function "permdock".permdock_approval_resolve(text, jsonb, integer) from public, anon, authenticated;

-- consume an approved, unexpired, unconsumed request once

create or replace function "permdock".permdock_approval_consume(p_token text, p_now text)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  update "permdock".approval_requests a
  set consumed_at = p_now::timestamptz,
    body = a.body || jsonb_build_object('consumedAt', p_now)
  where a.token = p_token
    and a.status = 'approved'
    and a.consumed_at is null
    and a.expires_at > p_now::timestamptz
  returning a.body
$$;
revoke execute on function "permdock".permdock_approval_consume(text, text) from public, anon, authenticated;

-- one page in (createdAt, token) order after the cursor position

create or replace function "permdock".permdock_approval_list(p_filter jsonb, p_after_created text, p_after_token text, p_limit integer)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select a.body
  from "permdock".approval_requests a
  where (p_filter ->> 'status' is null or a.status = p_filter ->> 'status')
    and (p_filter ->> 'tenant' is null or a.tenant = p_filter ->> 'tenant')
    and (p_filter ->> 'principalId' is null or a.principal_id = p_filter ->> 'principalId')
    and (p_filter ->> 'actorId' is null or a.actor_id = p_filter ->> 'actorId')
    and (p_filter ->> 'session' is null or a.session = p_filter ->> 'session')
    and (p_after_created is null
      or (a.created_at collate "C", a.token collate "C") > (p_after_created collate "C", p_after_token collate "C"))
  order by a.created_at collate "C", a.token collate "C"
  limit p_limit
$$;
revoke execute on function "permdock".permdock_approval_list(jsonb, text, text, integer) from public, anon, authenticated;

create or replace function "permdock".permdock_approval_expire(p_now text)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with expired as (
    update "permdock".approval_requests a
    set status = 'expired', body = a.body || '{"status":"expired"}'::jsonb
    where a.status = 'pending' and a.expires_at <= p_now::timestamptz
    returning 1
  )
  select count(*)::integer from expired
$$;
revoke execute on function "permdock".permdock_approval_expire(text) from public, anon, authenticated;

-- reject every pending request the filter matches, as system:<by>

create or replace function "permdock".permdock_approval_cancel(p_filter jsonb, p_by text, p_note text, p_now text)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with cancelled as (
    update "permdock".approval_requests a
    set status = 'rejected',
      body = (a.body - 'note') || jsonb_strip_nulls(jsonb_build_object(
        'status', 'rejected', 'resolvedAt', p_now, 'resolvedBy', 'system:' || p_by, 'note', p_note
      ))
    where a.status = 'pending'
      and (p_filter ->> 'status' is null or a.status = p_filter ->> 'status')
      and (p_filter ->> 'tenant' is null or a.tenant = p_filter ->> 'tenant')
      and (p_filter ->> 'principalId' is null or a.principal_id = p_filter ->> 'principalId')
      and (p_filter ->> 'actorId' is null or a.actor_id = p_filter ->> 'actorId')
      and (p_filter ->> 'session' is null or a.session = p_filter ->> 'session')
    returning 1
  )
  select count(*)::integer from cancelled
$$;
revoke execute on function "permdock".permdock_approval_cancel(jsonb, text, text, text) from public, anon, authenticated;

-- approvers: whether the signed-in user matches a request's approvers.by; policies on approval views call it

create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text default null)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_user text := (select "permdock".permdock_user_id())::text;
begin
  if coalesce(v_user, '') = '' or p_approvers is null then
    return false;
  end if;
  if jsonb_typeof(p_approvers) = 'array' then
    if jsonb_array_length(p_approvers) = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_approvers) loop
      if not "permdock".permdock_is_approver(v_item, p_tenant) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if jsonb_typeof(p_approvers) <> 'object' then
    return false;
  end if;
  case p_approvers ->> 'kind'
    when 'user' then
      return coalesce(p_approvers ->> 'id' = v_user, false);
    when 'permission' then
      if p_tenant is null then
        return coalesce("permdock".permdock_has_permission(p_approvers ->> 'permission'), false);
      end if;
      return exists (
          select 1
          from "permdock".permitted_organization_ids_by_permission(p_approvers ->> 'permission') i(id)
          where i.id::text = p_tenant
        );
    when 'any-of' then
      if jsonb_typeof(p_approvers -> 'of') <> 'array' then
        return false;
      end if;
      for v_item in select value from jsonb_array_elements(p_approvers -> 'of') loop
        if "permdock".permdock_is_approver(v_item, p_tenant) then
          return true;
        end if;
      end loop;
      return false;
    else
      return false;
  end case;
end;
$$;
revoke execute on function "permdock".permdock_is_approver(jsonb, text) from public, anon;
grant execute on function "permdock".permdock_is_approver(jsonb, text) to authenticated;

-- approval delegations: out-of-office covers a user writes for themselves; tableApprovalDelegationSource and permdock_is_approver read them

create table if not exists "permdock".approval_delegations (
  id text primary key default gen_random_uuid()::text,
  delegator uuid not null default ("permdock".permdock_user_id())::uuid,
  delegate uuid not null,
  tenant text,
  permissions text[],
  resources text[],
  "from" timestamptz not null default now(),
  "until" timestamptz not null,
  created_at timestamptz not null default now(),
  constraint "approval_delegations_window" check ("from" < "until"),
  constraint "approval_delegations_distinct" check (delegator <> delegate)
);

create index if not exists "approval_delegations_delegate" on "permdock".approval_delegations (delegate, "until");
alter table "permdock".approval_delegations enable row level security;
revoke all on table "permdock".approval_delegations from anon, public;
grant select, insert, update, delete on table "permdock".approval_delegations to authenticated;

create policy "approval_delegations_read" on "permdock".approval_delegations
  for select to authenticated
  using (delegator::text = (select "permdock".permdock_user_id())::text or delegate::text = (select "permdock".permdock_user_id())::text);

create policy "approval_delegations_insert" on "permdock".approval_delegations
  for insert to authenticated
  with check (delegator::text = (select "permdock".permdock_user_id())::text and (tenant is null or tenant in (select m.id::text from "permdock".member_organization_ids() m(id))));

create policy "approval_delegations_update" on "permdock".approval_delegations
  for update to authenticated
  using (delegator::text = (select "permdock".permdock_user_id())::text)
  with check (delegator::text = (select "permdock".permdock_user_id())::text and (tenant is null or tenant in (select m.id::text from "permdock".member_organization_ids() m(id))));

create policy "approval_delegations_delete" on "permdock".approval_delegations
  for delete to authenticated
  using (delegator::text = (select "permdock".permdock_user_id())::text);

-- approval delegations: whether a delegator's own rights match approvers.by; only permdock_is_approver calls it

create or replace function "permdock".permdock_cover_approves(p_delegator uuid, p_approvers jsonb, p_tenant text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  if p_delegator is null or p_approvers is null then
    return false;
  end if;
  if jsonb_typeof(p_approvers) = 'array' then
    if jsonb_array_length(p_approvers) = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_approvers) loop
      if not "permdock".permdock_cover_approves(p_delegator, v_item, p_tenant) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if jsonb_typeof(p_approvers) <> 'object' then
    return false;
  end if;
  case p_approvers ->> 'kind'
    when 'user' then
      return coalesce(p_approvers ->> 'id' = p_delegator::text, false);
    when 'permission' then
      if p_tenant is null then
        return coalesce("permdock".permdock_has_permission_for(p_delegator, p_approvers ->> 'permission'), false);
      end if;
      return exists (
          select 1
          from "permdock".permitted_organization_ids_by_permission_for(p_delegator, p_approvers ->> 'permission') i(id)
          where i.id::text = p_tenant
        );
    when 'any-of' then
      if jsonb_typeof(p_approvers -> 'of') <> 'array' then
        return false;
      end if;
      for v_item in select value from jsonb_array_elements(p_approvers -> 'of') loop
        if "permdock".permdock_cover_approves(p_delegator, v_item, p_tenant) then
          return true;
        end if;
      end loop;
      return false;
    else
      return false;
  end case;
end;
$$;
revoke execute on function "permdock".permdock_cover_approves(uuid, jsonb, text) from public, anon, authenticated;

-- approvers with covers: the signed-in user, or a delegate inside an active cover of a delegator who is not the requester

create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text, p_requester text, p_resource text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_delegator uuid;
  v_user text := (select "permdock".permdock_user_id())::text;
begin
  if "permdock".permdock_is_approver(p_approvers, p_tenant) then
    return true;
  end if;
  if coalesce(v_user, '') = '' or coalesce(p_requester, '') = '' then
    return false;
  end if;
  if p_tenant is not null and not (p_tenant in (select m.id::text from "permdock".member_organization_ids() m(id))) then
    return false;
  end if;
  for v_delegator in
    select d.delegator
    from "permdock".approval_delegations d
    where d.delegate::text = v_user
      and d.delegator::text <> v_user
      and d.delegator::text <> p_requester
      and d."from" <= now()
      and now() < d."until"
      and (d.tenant is null or d.tenant = p_tenant)
      and d.permissions is null
      and (d.resources is null or p_resource = any (d.resources))
  loop
    if "permdock".permdock_cover_approves(v_delegator, p_approvers, p_tenant) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke execute on function "permdock".permdock_is_approver(jsonb, text, text, text) from public, anon;
grant execute on function "permdock".permdock_is_approver(jsonb, text, text, text) to authenticated;

-- organization: holder counts (min / max) over the membership sources, checked at commit

-- generated by permdock rls generate
-- fail-closed: never target a bypass role

alter table "public"."staff" enable row level security;
revoke all on table "public"."staff" from anon, authenticated;
grant select on table "public"."staff" to authenticated;

alter table "public"."quotes" enable row level security;
revoke all on table "public"."quotes" from anon, authenticated;
grant select on table "public"."quotes" to anon;
grant select, update on table "public"."quotes" to authenticated;

create policy "quotes_select_anon"
  on "public"."quotes"
  as permissive
  for select
  to anon
  using ("id"::text in (select "permdock".permdock_capability_ids('quotes', 'guest', 'quotes.read')));
