-- better-supabase module: share-links
-- @bsb-block share-links@1 managed
-- @bsb-hash sha256:5b3c30c784bf4c0aa67bef52255acda95450487768d0c2c3bd25eb52e6c8a364
-- Hashed share links, view counts and per-user state. The token is returned once. Resolving a link hashes the token the caller presents, so a stored plaintext token keeps working after it is hashed. A link can take a password, checked with bcrypt and rate-limited per link, and turn off downloads.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create table "better_supabase"."share_links" (
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
alter table "better_supabase"."share_links" add column "version_id" uuid;
alter table "better_supabase"."share_links" add column "use_count" integer not null default 0;
alter table "better_supabase"."share_links" add column "last_used_at" timestamptz;
alter table "better_supabase"."share_links" add column "password_hash" text;
alter table "better_supabase"."share_links" add column "download_allowed" boolean not null default true;
alter table "better_supabase"."share_links" enable row level security;
revoke all on "better_supabase"."share_links" from public, anon, authenticated;
grant select on "better_supabase"."share_links" to authenticated;
grant all on "better_supabase"."share_links" to service_role;
create index "share_links_subject_idx" on "better_supabase"."share_links" ("tenant_id", "subject_type", "subject_id");
create table "better_supabase"."subject_views" (
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

create table "better_supabase"."subject_user_state" (
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
-- fields: the extra columns (columns your schema files add) to set.

-- password: at least 8 characters; resolve_share_link then needs it.
-- download_allowed: false tells the block that serves the subject not to offer
-- a download.
create or replace function "better_supabase"."create_share_link"(tenant uuid, subject_type text, subject_id text, role text, version_id uuid default null, expires_at timestamptz default null, max_uses integer default null, password text default null, download_allowed boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_id uuid;
  v_subject_ok boolean;
  v_password_hash text;
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
  if create_share_link.password is not null and char_length(create_share_link.password) < 8 then
    raise exception 'a link password needs at least 8 characters' using errcode = '22023', hint = 'SHARE_LINK_PASSWORD_INVALID';
  end if;

  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'this subject type can''t be shared' using errcode = '22023', hint = 'SHARE_SUBJECT_UNKNOWN';
  end if;
  if create_share_link.version_id is not null then
    raise exception 'install the versions module to share a version' using errcode = '22023', hint = 'SHARE_VERSION_INVALID';
  end if;
  if create_share_link.password is not null then
    v_password_hash := extensions.crypt(create_share_link.password, extensions.gen_salt('bf'));
  end if;
  insert into "better_supabase"."share_links" ("tenant_id", "subject_type", "subject_id", "token_hash", "role", "expires_at", "max_uses", "created_by", "version_id", "password_hash", "download_allowed")
  values (create_share_link.tenant, create_share_link.subject_type, create_share_link.subject_id, encode(extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex'), coalesce(create_share_link.role, 'view'), create_share_link.expires_at, create_share_link.max_uses, auth.uid(), create_share_link.version_id, v_password_hash, coalesce(create_share_link.download_allowed, true))
  returning "id" into v_id;
  null;
  return jsonb_build_object('id', v_id, 'token', v_token);
end;
$$;
revoke execute on function "better_supabase"."create_share_link"(uuid, text, text, text, uuid, timestamptz, integer, text, boolean) from public, anon;
grant execute on function "better_supabase"."create_share_link"(uuid, text, text, text, uuid, timestamptz, integer, text, boolean) to authenticated, service_role;

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
-- the last use. A link with a password returns only
-- { "passwordRequired": true } until the call passes the password, and
-- counts no use for it.

create or replace function "better_supabase"."resolve_share_link"(token text, password text default null)
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
  if v_link."password_hash" is not null then
    if resolve_share_link.password is null then
      return jsonb_build_object('passwordRequired', true);
    end if;
    if extensions.crypt(resolve_share_link.password, v_link."password_hash") <> v_link."password_hash" then
      return jsonb_build_object('passwordRequired', true);
    end if;
  end if;
  update "better_supabase"."share_links" set "use_count" = "use_count" + 1, "last_used_at" = now() where "id" = v_link."id";
  return jsonb_build_object('id', v_link."id", 'organizationId', v_link."tenant_id", 'subjectType', v_link."subject_type", 'subjectId', v_link."subject_id", 'role', v_link."role", 'versionId', v_link."version_id", 'expiresAt', v_link."expires_at", 'maxUses', v_link."max_uses", 'downloadAllowed', v_link."download_allowed", 'passwordRequired', v_link."password_hash" is not null);
end;
$$;
revoke all on function "better_supabase"."resolve_share_link"(text, text) from public, anon, authenticated;
grant execute on function "better_supabase"."resolve_share_link"(text, text) to anon, authenticated, service_role;

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
  select coalesce(jsonb_agg(jsonb_build_object('id', l."id", 'role', l."role", 'expiresAt', l."expires_at", 'revokedAt', l."revoked_at", 'downloadAllowed', l."download_allowed", 'passwordRequired', l."password_hash" is not null)), '[]'::jsonb)
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
create policy bsb_tenant_scope_select on "better_supabase"."share_links" as restrictive
  for select to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_insert on "better_supabase"."share_links" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."share_links" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."share_links" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));

-- Row audit for the module's tables (blocks.audit.options.blockTables)
create constraint trigger bsb_audit after insert or update or delete on better_supabase.share_links deferrable initially deferred for each row when (better_supabase.import_run() is null or current_setting('better_supabase.import_audit', true) is distinct from 'summary') execute function better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"share_link","event_prefix":"share_link"}');
