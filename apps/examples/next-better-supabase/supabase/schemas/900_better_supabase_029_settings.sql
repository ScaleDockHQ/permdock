-- better-supabase module: settings
-- @bsb-block settings@1 managed
-- @bsb-hash sha256:a827da5e65d863f196c6bf8325887ed1b11f7c391ac020c041d79c2aa1a19f8b
-- Per-user, per-organization and platform-wide settings as key-value jsonb rows. Users read and write their own; organization settings check settings.read and settings.update; platform settings check a platform permission per key. Keys with a JSON Schema in options.schemas get a pg_jsonschema check.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

-- Settings as key-value rows. The app validates values with defineSettings();
-- keys with a JSON Schema also get a pg_jsonschema check below.
create table "better_supabase"."user_settings" (
  "user_id" uuid not null references auth.users (id) on delete cascade,
  "key" text not null constraint bsb_user_settings_key_check check ("key" ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  "value" jsonb not null,
  "updated_by" uuid references auth.users (id) on delete set null default auth.uid(),
  "updated_at" timestamptz not null default now(),
  primary key ("user_id", "key")
);
create index user_settings_updated_by_idx on "better_supabase"."user_settings" ("updated_by");
alter table "better_supabase"."user_settings" enable row level security;
revoke all on "better_supabase"."user_settings" from public, anon, authenticated;
grant select, insert, update, delete on "better_supabase"."user_settings" to authenticated;
grant all on "better_supabase"."user_settings" to service_role;
create policy bsb_user_settings_own_read on "better_supabase"."user_settings"
  for select to authenticated
  using ("user_id" = (select auth.uid()));
create policy bsb_user_settings_own_insert on "better_supabase"."user_settings"
  for insert to authenticated
  with check (("user_id" = (select auth.uid())) and (select permdock.permdock_actor_may_write()));
create policy bsb_user_settings_own_update on "better_supabase"."user_settings"
  for update to authenticated
  using (("user_id" = (select auth.uid())) and (select permdock.permdock_actor_may_write()))
  with check (("user_id" = (select auth.uid())) and (select permdock.permdock_actor_may_write()));
create policy bsb_user_settings_own_delete on "better_supabase"."user_settings"
  for delete to authenticated
  using (("user_id" = (select auth.uid())) and (select permdock.permdock_actor_may_write()));

create table "better_supabase"."organization_settings" (
  "tenant_id" uuid not null,
  "key" text not null constraint bsb_organization_settings_key_check check ("key" ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  "value" jsonb not null,
  "updated_by" uuid references auth.users (id) on delete set null default auth.uid(),
  "updated_at" timestamptz not null default now(),
  primary key ("tenant_id", "key")
);
create index organization_settings_updated_by_idx on "better_supabase"."organization_settings" ("updated_by");
alter table "better_supabase"."organization_settings" enable row level security;
revoke all on "better_supabase"."organization_settings" from public, anon, authenticated;
grant select, insert, update, delete on "better_supabase"."organization_settings" to authenticated;
grant all on "better_supabase"."organization_settings" to service_role;
create policy bsb_organization_settings_read on "better_supabase"."organization_settings"
  for select to authenticated
  using ("tenant_id" in (select better_supabase.tenant_ids_with('settings.read')));
create policy bsb_organization_settings_insert on "better_supabase"."organization_settings"
  for insert to authenticated
  with check (("tenant_id" in (select better_supabase.tenant_ids_with('settings.update'))) and (select permdock.permdock_actor_may_write()));
create policy bsb_organization_settings_update on "better_supabase"."organization_settings"
  for update to authenticated
  using (("tenant_id" in (select better_supabase.tenant_ids_with('settings.update'))) and (select permdock.permdock_actor_may_write()))
  with check (("tenant_id" in (select better_supabase.tenant_ids_with('settings.update'))) and (select permdock.permdock_actor_may_write()));
create policy bsb_organization_settings_delete on "better_supabase"."organization_settings"
  for delete to authenticated
  using (("tenant_id" in (select better_supabase.tenant_ids_with('settings.update'))) and (select permdock.permdock_actor_may_write()));

-- Platform settings: one row per key for the whole product, such as fee
-- rates or feature switches an admin console edits. Each key's permission
-- (is_platform) guards writes, and its read rule decides who sees it.
create table "better_supabase"."platform_settings" (
  "key" text primary key constraint bsb_platform_settings_key_check check ("key" ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  "value" jsonb not null,
  "updated_by" uuid references auth.users (id) on delete set null default auth.uid(),
  "updated_at" timestamptz not null default now()
);
create index platform_settings_updated_by_idx on "better_supabase"."platform_settings" ("updated_by");
alter table "better_supabase"."platform_settings" enable row level security;
revoke all on "better_supabase"."platform_settings" from public, anon, authenticated;
grant select on "better_supabase"."platform_settings" to anon;
grant select, insert, update, delete on "better_supabase"."platform_settings" to authenticated;
grant all on "better_supabase"."platform_settings" to service_role;
create policy bsb_platform_settings_read on "better_supabase"."platform_settings"
  for select to authenticated
  using (true);
create policy bsb_platform_settings_read_public on "better_supabase"."platform_settings"
  for select to anon
  using (false);
create policy bsb_platform_settings_insert on "better_supabase"."platform_settings"
  for insert to authenticated
  with check (((select coalesce(better_supabase.is_platform('settings.manage'), false))) and (select permdock.permdock_actor_may_write()));
create policy bsb_platform_settings_update on "better_supabase"."platform_settings"
  for update to authenticated
  using (((select coalesce(better_supabase.is_platform('settings.manage'), false))) and (select permdock.permdock_actor_may_write()))
  with check (((select coalesce(better_supabase.is_platform('settings.manage'), false))) and (select permdock.permdock_actor_may_write()));
create policy bsb_platform_settings_delete on "better_supabase"."platform_settings"
  for delete to authenticated
  using (((select coalesce(better_supabase.is_platform('settings.manage'), false))) and (select permdock.permdock_actor_may_write()));

-- The functions run as the caller, so the policies above decide. set_*
-- takes the value inside an envelope, { "value": ... }, so strings and
-- numbers reach jsonb the same way over Postgres and the Data API.
create or replace function "better_supabase"."get_user_settings"()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(s."key", s."value"), '{}'::jsonb)
  from "better_supabase"."user_settings" s
  where s."user_id" = auth.uid()
$$;

create or replace function "better_supabase"."set_user_setting"(key text, value jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  insert into "better_supabase"."user_settings" ("user_id", "key", "value", "updated_by", "updated_at")
  values (auth.uid(), set_user_setting.key, coalesce(set_user_setting.value -> 'value', 'null'::jsonb), auth.uid(), now())
  on conflict ("user_id", "key") do update
    set "value" = excluded."value", "updated_by" = auth.uid(), "updated_at" = now()
  returning "value"
$$;

create or replace function "better_supabase"."reset_user_setting"(key text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with removed as (
    delete from "better_supabase"."user_settings" s where s."user_id" = auth.uid() and s."key" = reset_user_setting.key
    returning 1
  )
  select exists (select 1 from removed)
$$;

create or replace function "better_supabase"."get_organization_settings"(tenant uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(s."key", s."value"), '{}'::jsonb)
  from "better_supabase"."organization_settings" s
  where s."tenant_id" = get_organization_settings.tenant
$$;

create or replace function "better_supabase"."set_organization_setting"(tenant uuid, key text, value jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  insert into "better_supabase"."organization_settings" ("tenant_id", "key", "value", "updated_by", "updated_at")
  values (set_organization_setting.tenant, set_organization_setting.key, coalesce(set_organization_setting.value -> 'value', 'null'::jsonb), auth.uid(), now())
  on conflict ("tenant_id", "key") do update
    set "value" = excluded."value", "updated_by" = auth.uid(), "updated_at" = now()
  returning "value"
$$;

create or replace function "better_supabase"."reset_organization_setting"(tenant uuid, key text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with removed as (
    delete from "better_supabase"."organization_settings" s
    where s."tenant_id" = reset_organization_setting.tenant and s."key" = reset_organization_setting.key
    returning 1
  )
  select exists (select 1 from removed)
$$;

-- One organization setting for other modules' security definer functions,
-- which decide who may see it. Returns null when the key is not set.
create or replace function "better_supabase"."organization_setting"(tenant uuid, key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select s."value"
  from "better_supabase"."organization_settings" s
  where s."tenant_id" = organization_setting.tenant and s."key" = organization_setting.key
$$;

create or replace function "better_supabase"."get_platform_settings"()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(s."key", s."value"), '{}'::jsonb)
  from "better_supabase"."platform_settings" s
$$;

create or replace function "better_supabase"."set_platform_setting"(key text, value jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  insert into "better_supabase"."platform_settings" ("key", "value", "updated_by", "updated_at")
  values (set_platform_setting.key, coalesce(set_platform_setting.value -> 'value', 'null'::jsonb), auth.uid(), now())
  on conflict ("key") do update
    set "value" = excluded."value", "updated_by" = auth.uid(), "updated_at" = now()
  returning "value"
$$;

create or replace function "better_supabase"."reset_platform_setting"(key text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with removed as (
    delete from "better_supabase"."platform_settings" s where s."key" = reset_platform_setting.key
    returning 1
  )
  select exists (select 1 from removed)
$$;

revoke execute on function "better_supabase"."get_platform_settings"() from public;
revoke execute on function "better_supabase"."set_platform_setting"(text, jsonb) from public, anon;
revoke execute on function "better_supabase"."reset_platform_setting"(text) from public, anon;
grant execute on function "better_supabase"."get_platform_settings"() to anon, authenticated, service_role;
grant execute on function "better_supabase"."set_platform_setting"(text, jsonb) to authenticated, service_role;
grant execute on function "better_supabase"."reset_platform_setting"(text) to authenticated, service_role;
revoke execute on function "better_supabase"."get_user_settings"() from public, anon;
revoke execute on function "better_supabase"."set_user_setting"(text, jsonb) from public, anon;
revoke execute on function "better_supabase"."reset_user_setting"(text) from public, anon;
revoke execute on function "better_supabase"."get_organization_settings"(uuid) from public, anon;
revoke execute on function "better_supabase"."set_organization_setting"(uuid, text, jsonb) from public, anon;
revoke execute on function "better_supabase"."reset_organization_setting"(uuid, text) from public, anon;
grant execute on function "better_supabase"."get_user_settings"() to authenticated, service_role;
grant execute on function "better_supabase"."set_user_setting"(text, jsonb) to authenticated, service_role;
grant execute on function "better_supabase"."reset_user_setting"(text) to authenticated, service_role;
grant execute on function "better_supabase"."get_organization_settings"(uuid) to authenticated, service_role;
grant execute on function "better_supabase"."set_organization_setting"(uuid, text, jsonb) to authenticated, service_role;
grant execute on function "better_supabase"."reset_organization_setting"(uuid, text) to authenticated, service_role;
revoke execute on function "better_supabase"."organization_setting"(uuid, text) from public, anon, authenticated;
grant execute on function "better_supabase"."organization_setting"(uuid, text) to service_role;

-- Records organization and platform setting changes; user settings are not
-- recorded.
create or replace function "better_supabase"."record_organization_setting"()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."organization_settings";
begin
  if tg_op = 'DELETE' then
    v_row := old;
    perform better_supabase.audit_event(
    event_type => 'organization_setting.reset',
    category => 'configuration',
    target_type => 'setting',
    record_id => v_row."key",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'key', v_row."key")
  );
  else
    v_row := new;
    perform better_supabase.audit_event(
    event_type => 'organization_setting.updated',
    category => 'configuration',
    target_type => 'setting',
    record_id => v_row."key",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'key', v_row."key")
  );
  end if;
  return null;
end;
$$;
revoke execute on function "better_supabase"."record_organization_setting"() from public, anon, authenticated;
create trigger "bsb_record_organization_setting" after insert or update or delete on "better_supabase"."organization_settings"
  for each row
  execute function "better_supabase"."record_organization_setting"();
create or replace function "better_supabase"."record_platform_setting"()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."platform_settings";
begin
  if tg_op = 'DELETE' then
    v_row := old;
    perform better_supabase.audit_event(
    event_type => 'platform_setting.reset',
    category => 'configuration',
    target_type => 'setting',
    record_id => v_row."key",
    metadata => jsonb_build_object('key', v_row."key")
  );
  else
    v_row := new;
    perform better_supabase.audit_event(
    event_type => 'platform_setting.updated',
    category => 'configuration',
    target_type => 'setting',
    record_id => v_row."key",
    metadata => jsonb_build_object('key', v_row."key")
  );
  end if;
  return null;
end;
$$;
revoke execute on function "better_supabase"."record_platform_setting"() from public, anon, authenticated;
create trigger "bsb_record_platform_setting" after insert or update or delete on "better_supabase"."platform_settings"
  for each row
  execute function "better_supabase"."record_platform_setting"();

-- Tenant isolation (ADR 0099): permissive policies combine with or, so one
-- the app adds would widen the block's. These restrictive policies keep each
-- table to the caller's organizations and what the block's policies grant.
create policy bsb_tenant_scope_select on "better_supabase"."organization_settings" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('settings.read')))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."organization_settings" as restrictive
  for insert to public
  with check (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('settings.update')))
  );
create policy bsb_tenant_scope_update on "better_supabase"."organization_settings" as restrictive
  for update to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('settings.update')))
  )
  with check (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('settings.update')))
  );
create policy bsb_tenant_scope_delete on "better_supabase"."organization_settings" as restrictive
  for delete to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('settings.update')))
  );
