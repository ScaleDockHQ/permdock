-- better-supabase module: share-links
-- @bsb-block share-links@1 managed
-- @bsb-hash sha256:211537e85bc9f8240b429d35ef56f627e5a686f34222683ed73d9754154244aa
-- Hashed share links, view counts and per-user state. The token is returned once. Resolving a link hashes the token the caller presents, so a stored plaintext token keeps working after it is hashed.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
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
-- The tenant scope policies call the module's functions, so they go before
-- the module drops or replaces one and come back at the end.
do $$
begin
  begin
    drop policy if exists bsb_tenant_scope on "better_supabase"."share_links";
    drop policy if exists bsb_tenant_scope_select on "better_supabase"."share_links";
    drop policy if exists bsb_tenant_scope_insert on "better_supabase"."share_links";
    drop policy if exists bsb_tenant_scope_update on "better_supabase"."share_links";
    drop policy if exists bsb_tenant_scope_delete on "better_supabase"."share_links";
  exception when undefined_table or invalid_schema_name then null;
  end;
end $$;

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
alter table "better_supabase"."share_links" add column if not exists "last_used_at" timestamptz;
alter table "better_supabase"."share_links" enable row level security;
revoke all on "better_supabase"."share_links" from public, anon, authenticated;
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
revoke all on "better_supabase"."subject_views" from public, anon, authenticated;
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
revoke all on "better_supabase"."subject_user_state" from public, anon, authenticated;
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
    or (v_creator is not null and coalesce(v_creator = auth.uid(), false))
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
  update "better_supabase"."share_links" set "use_count" = "use_count" + 1, "last_used_at" = now() where "id" = v_link."id";
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

-- Tenant isolation (ADR 0099): permissive policies combine with or, so one
-- the app adds would widen the block's. These restrictive policies keep each
-- table to the caller's organizations and what the block's policies grant.
-- Until memberships installs, the caller is a member of no organization.
do $$
begin
  if to_regprocedure('better_supabase.member_organization_ids(text[])') is null then
    create function better_supabase.member_organization_ids(roles text[] default null)
    returns setof uuid
    language sql
    stable
    set search_path = ''
    as $members$ select null::uuid where false $members$;
  end if;
end $$;
drop policy if exists bsb_tenant_scope on "better_supabase"."share_links";
drop policy if exists bsb_tenant_scope_select on "better_supabase"."share_links";
create policy bsb_tenant_scope_select on "better_supabase"."share_links" as restrictive
  for select to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));
drop policy if exists bsb_tenant_scope_insert on "better_supabase"."share_links";
create policy bsb_tenant_scope_insert on "better_supabase"."share_links" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
drop policy if exists bsb_tenant_scope_update on "better_supabase"."share_links";
create policy bsb_tenant_scope_update on "better_supabase"."share_links" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
drop policy if exists bsb_tenant_scope_delete on "better_supabase"."share_links";
create policy bsb_tenant_scope_delete on "better_supabase"."share_links" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));

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
revoke all on better_supabase.blocks from public, anon, authenticated;
grant select on better_supabase.blocks to service_role;
