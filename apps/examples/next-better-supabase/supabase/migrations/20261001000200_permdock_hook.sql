-- permdock:hook v1 schema=public tenant=tenant_id budget=1024 claims=user_role,roles,memberships,memberships_truncated,tenant_id,authz_ver,datetime_preferences,features
-- custom_access_token_hook(jsonb): memberships go active organization first and stop at the budget
-- supabase/config.toml:
--   [auth]
--   jwt_expiry = 900
--
--   [auth.hook.custom_access_token]
--   enabled = true
--   uri = "pg-functions://postgres/public/custom_access_token_hook"
-- the supabase_auth_admin grants are in supabase/migrations/20261001000210_permdock_hook_grants.sql

create or replace function "public".custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  uid text := event ->> 'user_id';
  active text;
  held jsonb;
  kept jsonb := '[]'::jsonb;
  truncated boolean := false;
  in_active boolean := false;
  budget integer := 1024;
  used integer := 0;
  item record;
  extra jsonb;
  ver bigint;
begin
  claims := claims - 'attrs' - 'datetime_preferences' - 'features';
  select coalesce(jsonb_agg(distinct r."role"::text order by r."role"::text), '[]'::jsonb)
    into held
    from "public"."user_roles" r
    where r."user_id"::text = uid;
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := (select u.raw_app_meta_data ->> 'active_organization' from auth.users u where u.id = uid::uuid);
  for item in
    select x.entry, x.tenant is not distinct from active as current
    from (
      select 0 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expiresAt', s.expires_at, 'grantedBy', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managedBy', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."memberships" m
        where m."user_id"::text = uid
        group by m."scope"::text, m."scope_id"::text
      ) s
      union all
      select 1 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expiresAt', s.expires_at, 'grantedBy', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managedBy', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."contacts" m
        where m."user_id"::text = uid
        group by m."customer_id", m."organization_id"
      ) s
    ) x
    order by (x.tenant is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
  loop
    if octet_length((kept || jsonb_build_array(item.entry))::text) + used > budget then
      truncated := true;
      exit;
    end if;
    kept := kept || jsonb_build_array(item.entry);
    in_active := in_active or (active is not null and item.current);
  end loop;
  claims := jsonb_set(claims, '{memberships}', kept);
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));
  end if;
  extra := "public"."datetime_preference_claims"(uid::uuid);
  if extra is not null then
    claims := jsonb_set(claims, '{datetime_preferences}', extra);
  end if;
  extra := "public"."feature_claims"(uid::uuid);
  if extra is not null then
    claims := jsonb_set(claims, '{features}', extra);
  end if;
  select v.version into ver from "public"."permdock_authz_version" v where v.user_id = uid;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(coalesce(ver, 0)));
  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- the authorization version: bumped on every membership change, written to authz_ver
create table if not exists "public"."permdock_authz_version" (
  user_id text primary key,
  version bigint not null default 0
);
alter table "public"."permdock_authz_version" enable row level security;
revoke all on table "public"."permdock_authz_version" from anon, authenticated, public;

create or replace function "public".permdock_bump_authz_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  column_name text := tg_argv[0];
  affected text;
begin
  foreach affected in array array[
    case when tg_op <> 'INSERT' then to_jsonb(old) ->> column_name end,
    case when tg_op <> 'DELETE' then to_jsonb(new) ->> column_name end
  ] loop
    if affected is not null then
      insert into "public"."permdock_authz_version" as v (user_id, version) values (affected, 1)
      on conflict (user_id) do update set version = v.version + 1;
    end if;
  end loop;
  return null;
end;
$$;
revoke execute on function "public".permdock_bump_authz_version() from public, anon, authenticated;
drop trigger if exists "permdock_authz_version" on "public"."memberships";
create trigger "permdock_authz_version"
  after insert or update or delete on "public"."memberships"
  for each row execute function "public".permdock_bump_authz_version('user_id');
drop trigger if exists "permdock_authz_version" on "public"."contacts";
create trigger "permdock_authz_version"
  after insert or update or delete on "public"."contacts"
  for each row execute function "public".permdock_bump_authz_version('user_id');
drop trigger if exists "permdock_authz_version" on "public"."user_roles";
create trigger "permdock_authz_version"
  after insert or update or delete on "public"."user_roles"
  for each row execute function "public".permdock_bump_authz_version('user_id');
