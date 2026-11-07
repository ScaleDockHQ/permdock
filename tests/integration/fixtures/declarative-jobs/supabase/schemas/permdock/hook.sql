-- permdock:hook v1 schema=permdock tenant=tenant_id budget=1024 claims=user_role,roles,memberships,memberships_truncated,tenant_id,team_ids,team_ids_truncated,authz_ver
-- custom_access_token_hook(jsonb): memberships go active tenant first and stop at the budget
-- supabase/config.toml:
--   [auth]
--   jwt_expiry = 900
--
--   [auth.hook.custom_access_token]
--   enabled = true
--   uri = "pg-functions://postgres/permdock/custom_access_token_hook"

create schema if not exists "permdock";
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
  v_user_0 "public"."organization_members"."user_id"%type := p_user;
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
      select 'tenant'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."organization_members" m
      where m."user_id" = v_user_0
      group by m."organization_id"
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
security definer
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
  team_ids jsonb := '[]'::jsonb;
  team_truncated boolean := false;
  ver bigint;
begin
  claims := claims - 'attrs' - 'team_ids' - 'team_ids_truncated';
  active := claims -> 'app_metadata' ->> 'active_tenant';
  -- one statement reads the roles, the memberships, the teams and the authorization version; the budget counts every slice
  with pdk_roles as (
      select "permdock".global_roles_for(uid) as held
    ),
    pdk_version as (
      select coalesce((select v.version from "permdock"."permdock_authz_version" v where v.user_id = uid), 0) as ver
    ),
    pdk_teams as (
      select coalesce(jsonb_agg(to_jsonb(u.id::text) order by u.n), '[]'::jsonb) as team_ids
      from unnest(array(
        select team_id from "permdock".member_team_ids_for(uid, active) as team(team_id)
      )) with ordinality as u(id, n)
    ),
    pdk_entries as (
      select e.ord, e.entry, case when e.entry ->> 'scope' = 'tenant' then e.entry ->> 'id' else e.entry -> 'within' ->> 'tenant' end as root_id
      from "permdock".memberships_for(uid) e
    ),
    pdk_fixed as (
      select used + octet_length(pdk_roles.held::text) + octet_length(pdk_version.ver::text) as bytes from pdk_roles, pdk_version
    ),
    pdk_ranked as (
      select x.entry, x.root_id is not distinct from active as current,
        row_number() over w as n,
        sum(octet_length(x.entry::text)) over w as bytes
      from pdk_entries x
      window w as (
        order by (x.root_id is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
        rows between unbounded preceding and current row
      )
    ),
    pdk_kept as (
      select r.* from pdk_ranked r, pdk_fixed f where f.bytes + 2 + r.bytes + 2 * (r.n - 1) <= budget
    )
  select
    (select pdk_roles.held from pdk_roles),
    coalesce((select jsonb_agg(k.entry order by k.n) from pdk_kept k), '[]'::jsonb),
    (select count(*) from pdk_ranked) > (select count(*) from pdk_kept),
    active is not null and coalesce((select bool_or(k.current) from pdk_kept k), false),
    (select bytes from pdk_fixed),
    (select pdk_teams.team_ids from pdk_teams),
    (select pdk_version.ver from pdk_version)
  into held, kept, truncated, in_active, used, team_ids, ver;
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  claims := jsonb_set(claims, '{memberships}', kept);
  -- the teams share the budget with the roles, the attrs, the version and the memberships already kept
  if used + octet_length(kept::text) + octet_length(team_ids::text) > budget then
    team_truncated := true;
  end if;
  if team_truncated then
    claims := jsonb_set(claims, '{team_ids_truncated}', 'true'::jsonb);
  else
    claims := claims - 'team_ids_truncated';
    if team_ids <> '[]'::jsonb then
      claims := jsonb_set(claims, '{team_ids}', team_ids);
    end if;
  end if;
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));
  end if;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(ver));
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

-- one bump per statement: the users in the transition tables, old and new, each once
create or replace function "permdock".permdock_bump_authz_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  column_name text := tg_argv[0];
  users uuid[] := '{}';
  holder uuid[];
begin
  if tg_op <> 'INSERT' then
    execute format('select coalesce(array_agg(distinct %1$I::text::uuid), ''{}'') from permdock_old where %1$I is not null', column_name)
      into holder;
    users := users || holder;
  end if;
  if tg_op <> 'DELETE' then
    execute format('select coalesce(array_agg(distinct %1$I::text::uuid), ''{}'') from permdock_new where %1$I is not null', column_name)
      into holder;
    users := users || holder;
  end if;
  perform "permdock".permdock_bump_authz_version_for(users);
  return null;
end;
$$;
revoke execute on function "permdock".permdock_bump_authz_version() from public, anon, authenticated;
create or replace trigger "permdock_authz_version_insert"
  after insert on "public"."organization_members"
  referencing new table as permdock_new
  for each statement execute function "permdock".permdock_bump_authz_version('user_id');
create or replace trigger "permdock_authz_version_update"
  after update on "public"."organization_members"
  referencing old table as permdock_old new table as permdock_new
  for each statement execute function "permdock".permdock_bump_authz_version('user_id');
create or replace trigger "permdock_authz_version_delete"
  after delete on "public"."organization_members"
  referencing old table as permdock_old
  for each statement execute function "permdock".permdock_bump_authz_version('user_id');
create or replace trigger "permdock_authz_version_insert"
  after insert on "permdock"."user_roles"
  referencing new table as permdock_new
  for each statement execute function "permdock".permdock_bump_authz_version('user_id');
create or replace trigger "permdock_authz_version_update"
  after update on "permdock"."user_roles"
  referencing old table as permdock_old new table as permdock_new
  for each statement execute function "permdock".permdock_bump_authz_version('user_id');
create or replace trigger "permdock_authz_version_delete"
  after delete on "permdock"."user_roles"
  referencing old table as permdock_old
  for each statement execute function "permdock".permdock_bump_authz_version('user_id');
create or replace trigger "permdock_authz_version_insert"
  after insert on "public"."team_members"
  referencing new table as permdock_new
  for each statement execute function "permdock".permdock_bump_authz_version('user_id');
create or replace trigger "permdock_authz_version_update"
  after update on "public"."team_members"
  referencing old table as permdock_old new table as permdock_new
  for each statement execute function "permdock".permdock_bump_authz_version('user_id');
create or replace trigger "permdock_authz_version_delete"
  after delete on "public"."team_members"
  referencing old table as permdock_old
  for each statement execute function "permdock".permdock_bump_authz_version('user_id');

-- sends every version bump on the server topic and on the user's authz:<uid>
create or replace function "permdock".permdock_broadcast_authz_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is not null then
    for r in select * from permdock_new loop
      perform realtime.send(jsonb_build_object('user_id', r.user_id, 'version', r.version), 'changed', 'better_supabase:authz', true);
      perform realtime.send(jsonb_build_object('user_id', r.user_id, 'version', r.version), 'changed', 'authz:' || r.user_id::text, true);
    end loop;
  end if;
  return null;
end;
$$;
revoke execute on function "permdock".permdock_broadcast_authz_version() from public, anon, authenticated;
create or replace trigger permdock_authz_version_broadcast_insert
  after insert on "permdock"."permdock_authz_version"
  referencing new table as permdock_new
  for each statement execute function "permdock".permdock_broadcast_authz_version();
create or replace trigger permdock_authz_version_broadcast_update
  after update on "permdock"."permdock_authz_version"
  referencing new table as permdock_new
  for each statement execute function "permdock".permdock_broadcast_authz_version();

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
  team_ids jsonb := '[]'::jsonb;
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
  select coalesce((
    select jsonb_agg(to_jsonb(u.id::text) order by u.n)
    from unnest(array(
      select team_id from "permdock".member_team_ids_for(uid) as team(team_id)
    )) with ordinality as u(id, n)
  ), '[]'::jsonb)
    into team_ids;
  if team_ids <> '[]'::jsonb then
    claims := jsonb_set(claims, '{team_ids}', team_ids);
  end if;
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
      select m."user_id"::text as user_id, 'tenant'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."organization_members" m
      where $1::text = 'tenant' and m."organization_id"::text = $2::text
      group by m."user_id", m."organization_id"
      having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) s
$$;
revoke execute on function "permdock".members_of(text, text) from public, anon, authenticated;

-- supabase_auth_admin: execute only; the hook reads with its owner's rights
revoke execute on function "permdock".custom_access_token_hook(jsonb) from authenticated, anon, public;
grant usage on schema "permdock" to supabase_auth_admin;
grant execute on function "permdock".custom_access_token_hook(jsonb) to supabase_auth_admin;
