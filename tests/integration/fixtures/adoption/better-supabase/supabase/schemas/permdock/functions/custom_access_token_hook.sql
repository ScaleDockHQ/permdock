-- permdock:hook v1 schema=permdock tenant=tenant_id budget=1024 claims=user_role,roles,memberships,memberships_truncated,tenant_id,authz_ver
-- custom_access_token_hook(jsonb): memberships go active tenant first and stop at the budget
-- supabase/config.toml:
--   [auth]
--   jwt_expiry = 900
--
--   [auth.hook.custom_access_token]
--   enabled = true
--   uri = "pg-functions://postgres/permdock/custom_access_token_hook"

create schema "permdock";
revoke all on schema "permdock" from public;

-- the global roles of p_user as a json array; no client role may execute it
create or replace function "permdock".global_roles_for(p_user uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_roles_user "permdock"."user_roles"."user_id"%type := p_user;
  held jsonb;
begin
  select coalesce(jsonb_agg(distinct r."role"::text order by r."role"::text) filter (where r."role"::text is not null), '[]'::jsonb)
    into held
    from "permdock"."user_roles" r
    where r."user_id" = v_roles_user;
  return held;
end;
$$;
revoke execute on function "permdock".global_roles_for(uuid) from public, anon, authenticated;

-- the membership entries the hook and subject_for read for p_user; no client role may execute it
create or replace function "permdock".memberships_for(p_user uuid)
returns table (ord integer, entry jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_0 "public"."members"."user_id"%type := p_user;
begin
  return query
  select x.ord, x.entry
  from (
    select 0 as ord,
      (case when s.scope = 'tenant' then s.id else s.within ->> 'tenant' end) as tenant,
      jsonb_strip_nulls(jsonb_build_object(
        'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
        'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
        'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
        'managed_by', s.managed_by, 'entitlements', s.seats
      )) as entry
    from (
      select 'tenant'::text as scope, m."tenant_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."members" m
      where m."user_id" = v_user_0
      group by m."tenant_id"
      having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    ) s
  ) x;
end;
$$;
revoke execute on function "permdock".memberships_for(uuid) from public, anon, authenticated;

create or replace function "permdock".custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  uid uuid := (event ->> 'user_id')::uuid;
  active text;
  held jsonb;
  kept jsonb := '[]'::jsonb;
  truncated boolean := false;
  in_active boolean := false;
  budget integer := 1024;
  used integer := 0;
  item record;
  ver bigint;
begin
  claims := claims - 'attrs';
  held := "permdock".global_roles_for(uid);
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := claims -> 'app_metadata' ->> 'active_tenant';
  for item in
    select x.entry, x.root_id is not distinct from active as current
    from (
      select e.ord, e.entry, case when e.entry ->> 'scope' = 'tenant' then e.entry ->> 'id' else e.entry -> 'within' ->> 'tenant' end as root_id
      from "permdock".memberships_for(uid) e
    ) x
    order by (x.root_id is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
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
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(coalesce(ver, 0)));
  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- the authorization version: bumped on every membership change, written to authz_ver
create table "permdock"."permdock_authz_version" (
  user_id uuid primary key references auth.users on delete cascade,
  version bigint not null default 0
);
alter table "permdock"."permdock_authz_version" enable row level security;
revoke all on table "permdock"."permdock_authz_version" from anon, authenticated, public;

-- bumps each listed user once, skipping users already deleted from auth.users; no client role may call it
create or replace function "permdock".permdock_bump_authz_version_for(p_users uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  insert into "permdock"."permdock_authz_version" as v (user_id, version)
  select distinct u, 1 from unnest(p_users) u
  where u is not null and exists (select 1 from auth.users au where au.id = u)
  on conflict (user_id) do update set version = v.version + 1;
  select set_config(
    'permdock.m.gen',
    (coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0')::int + 1)::text,
    true
  )
$$;
revoke execute on function "permdock".permdock_bump_authz_version_for(uuid[]) from public, anon, authenticated;

create or replace function "permdock".permdock_bump_authz_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  column_name text := tg_argv[0];
begin
  perform "permdock".permdock_bump_authz_version_for(array[
    case when tg_op <> 'INSERT' then to_jsonb(old) ->> column_name end,
    case when tg_op <> 'DELETE' then to_jsonb(new) ->> column_name end
  ]::uuid[]);
  return null;
end;
$$;
revoke execute on function "permdock".permdock_bump_authz_version() from public, anon, authenticated;
create or replace trigger "permdock_authz_version"
  after insert or update or delete on "public"."members"
  for each row execute function "permdock".permdock_bump_authz_version('user_id');
create or replace trigger "permdock_authz_version"
  after insert or update or delete on "permdock"."user_roles"
  for each row execute function "permdock".permdock_bump_authz_version('user_id');

-- sends every version bump on the server topic and on the user's authz:<uid>
create or replace function "permdock".permdock_broadcast_authz_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is not null then
    perform realtime.send(jsonb_build_object('user_id', new.user_id, 'version', new.version), 'changed', 'better_supabase:authz', true);
    perform realtime.send(jsonb_build_object('user_id', new.user_id, 'version', new.version), 'changed', 'authz:' || new.user_id::text, true);
  end if;
  return null;
end;
$$;
revoke execute on function "permdock".permdock_broadcast_authz_version() from public, anon, authenticated;
create or replace trigger permdock_authz_version_broadcast
  after insert or update on "permdock"."permdock_authz_version"
  for each row execute function "permdock".permdock_broadcast_authz_version();

-- the subject the hook would mint for p_user, for a backend acting for a stored user; no client role may execute it
create or replace function "permdock".subject_for(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := p_user;
  held jsonb;
  memberships jsonb;
  custom jsonb := '[]'::jsonb;
  ver bigint;
  claims jsonb := '{}'::jsonb;
begin
  if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
    return null;
  end if;
  held := "permdock".global_roles_for(uid);
  select coalesce(jsonb_agg(x.entry order by x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text), '[]'::jsonb)
    into memberships
    from "permdock".memberships_for(uid) x;
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  ver := coalesce(ver, 0);
  return jsonb_strip_nulls(jsonb_build_object(
    'claims', case when claims = '{}'::jsonb then null else claims end,
    'id', uid::text,
    'active', true,
    'roles', held,
    'memberships', memberships,
    'customRoles', custom,
    'authzVersion', ver
  ));
end;
$$;
revoke execute on function "permdock".subject_for(uuid) from public, anon, authenticated;

-- the signed-in user's subject_for record, for a bootstrap that seeds the authorizer; null when anonymous or suspended
create or replace function "permdock".permdock_subject()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  subject jsonb := "permdock".subject_for((select "permdock".permdock_user_id()));
begin
  if subject is null or (subject ->> 'active') is distinct from 'true' then
    return null;
  end if;
  return subject;
end;
$$;
revoke execute on function "permdock".permdock_subject() from public, anon, authenticated;
grant execute on function "permdock".permdock_subject() to authenticated;

-- the authorization version subject_for reports for p_user, for a cheap freshness check; no client role may execute it
create or replace function "permdock".authz_version_for(p_user uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := p_user;
  ver bigint;
begin
  if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
    return null;
  end if;
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  ver := coalesce(ver, 0);
  return ver;
end;
$$;
revoke execute on function "permdock".authz_version_for(uuid) from public, anon, authenticated;

-- the live memberships of one scope instance, for a backend that lists members over PostgREST; no client role may execute it
create or replace function "permdock".members_of(p_scope text, p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'principal', jsonb_build_object('id', s.user_id),
      'membership', jsonb_strip_nulls(jsonb_build_object(
        'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
        'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
        'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
        'managed_by', s.managed_by, 'entitlements', s.seats
      ))
    ) order by s.user_id, s.roles::text), '[]'::jsonb)
  from (
      select m."user_id"::text as user_id, 'tenant'::text as scope, m."tenant_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."members" m
      where $1::text = 'tenant' and m."tenant_id"::text = $2::text
      group by m."user_id", m."tenant_id"
      having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) s
$$;
revoke execute on function "permdock".members_of(text, text) from public, anon, authenticated;

-- supabase_auth_admin: the grants and read policies the hook needs
grant usage on schema "permdock" to supabase_auth_admin;
grant execute on function "permdock".custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function "permdock".custom_access_token_hook(jsonb) from authenticated, anon, public;
grant execute on function "permdock".memberships_for(uuid) to supabase_auth_admin;
grant execute on function "permdock".global_roles_for(uuid) to supabase_auth_admin;
grant usage on schema "public" to supabase_auth_admin;
grant select on table "public"."members" to supabase_auth_admin;
create policy "permdock_auth_admin_read_memberships" on "public"."members"
  as permissive for select
  to supabase_auth_admin
  using (true);
grant select on table "permdock"."user_roles" to supabase_auth_admin;
create policy "permdock_auth_admin_read_roles" on "permdock"."user_roles"
  as permissive for select
  to supabase_auth_admin
  using (true);
grant select on table "permdock"."permdock_authz_version" to supabase_auth_admin;
create policy "permdock_auth_admin_read_version" on "permdock"."permdock_authz_version"
  as permissive for select
  to supabase_auth_admin
  using (true);
