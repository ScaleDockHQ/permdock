set local check_function_bodies = off;

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
  extra jsonb;
  ver bigint;
  fast boolean := false;
begin
  claims := claims - 'attrs' - 'custom_roles_ver' - 'datetime_preferences' - 'features' - 'user_role' - 'tenant_id';
  active := claims -> 'app_metadata' ->> 'tenant_id';

  -- a refresh whose token carries the current authz_ver keeps the roles, memberships and teams it holds; any doubt reads them again
  if event ->> 'authentication_method' = 'token_refresh'
    and not truncated
    and jsonb_typeof(event -> 'claims' -> 'authz_ver') = 'number'
    and jsonb_typeof(event -> 'claims' -> 'roles') = 'array'
    and jsonb_typeof(event -> 'claims' -> 'memberships') in ('array', 'object')
    and not (event -> 'claims' ? 'memberships_truncated') then
    select coalesce((select v.version from "permdock"."permdock_authz_version" v where v.user_id = uid), 0) into ver;
    if (event -> 'claims' ->> 'authz_ver')::numeric = ver then
      held := event -> 'claims' -> 'roles';
      kept := event -> 'claims' -> 'memberships';
      if used + 2 * octet_length(held::text) + octet_length(kept::text) + coalesce(octet_length(to_jsonb(active)::text), 0) + octet_length(ver::text) + 20 + 2 <= budget then
        fast := true;
      end if;
    end if;
  end if;
  if fast then
    in_active := active is not null and (
      case jsonb_typeof(kept)
        when 'object' then exists (
          select 1 from jsonb_array_elements(coalesce(kept -> 'e', '[]'::jsonb)) as x(e)
          where kept -> 's' ->> ((x.e ->> 0)::int) = 'organization' and x.e ->> 1 = case when active ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then translate(rtrim(encode(decode(replace(active, '-', ''), 'hex'), 'base64'), '='), '+/', '-_') else '=' || active end
        ) or exists (
          select 1 from jsonb_array_elements(coalesce(kept -> 'o', '[]'::jsonb)) as e(entry) where case when e.entry ->> 'scope' = 'organization' then e.entry ->> 'id' else e.entry -> 'within' ->> 'organization' end = active
        )
        else exists (
          select 1 from jsonb_array_elements(kept) as e(entry) where case when e.entry ->> 'scope' = 'organization' then e.entry ->> 'id' else e.entry -> 'within' ->> 'organization' end = active
        )
      end
    );
  else
    -- one statement reads the roles, the memberships and the authorization version; the budget counts every slice
    with pdk_roles as (
        select "permdock".global_roles_for(uid) as held
      ),
      pdk_version as (
        select coalesce((select v.version from "permdock"."permdock_authz_version" v where v.user_id = uid), 0) as ver
      ),
      pdk_entries as (
        select e.ord, e.entry, case when e.entry ->> 'scope' = 'organization' then e.entry ->> 'id' else e.entry -> 'within' ->> 'organization' end as root_id
        from "permdock".memberships_for(uid) e
      ),
      pdk_plain as (
        select x.ord, x.entry, x.root_id,
          x.entry - 'scope' - 'id' - 'roles' - 'via' = '{}'::jsonb
            and jsonb_typeof(x.entry -> 'scope') = 'string'
            and coalesce(jsonb_typeof(x.entry -> 'via'), 'string') = 'string'
            and jsonb_typeof(x.entry -> 'id') = 'string'
            and jsonb_typeof(x.entry -> 'roles') = 'array'
            and not exists (select 1 from jsonb_array_elements(x.entry -> 'roles') v where jsonb_typeof(v) <> 'string') as plain
        from pdk_entries x
      ),
      pdk_tables as (
        select
          coalesce((select jsonb_agg(t.v order by t.v collate "C") from (select distinct p.entry ->> 'scope' as v from pdk_plain p where p.plain) t), '[]'::jsonb) as s,
          coalesce((select jsonb_agg(t.v order by t.v collate "C") from (select distinct r.v from pdk_plain p cross join lateral jsonb_array_elements_text(p.entry -> 'roles') as r(v) where p.plain) t), '[]'::jsonb) as r,
          coalesce((select jsonb_agg(t.v order by t.v collate "C") from (select distinct p.entry ->> 'via' as v from pdk_plain p where p.plain and p.entry ? 'via') t), '[]'::jsonb) as v
      ),
      pdk_items as (
        select p.ord, p.entry, p.root_id, p.plain,
          case when p.plain then
            jsonb_build_array(
              (select a.n - 1 from jsonb_array_elements_text(t.s) with ordinality as a(v, n) where a.v = p.entry ->> 'scope'),
              case when (p.entry ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then translate(rtrim(encode(decode(replace((p.entry ->> 'id'), '-', ''), 'hex'), 'base64'), '='), '+/', '-_') else '=' || (p.entry ->> 'id') end,
              coalesce((select a.n - 1 from jsonb_array_elements_text(t.v) with ordinality as a(v, n) where a.v = p.entry ->> 'via'), -1)
            ) || coalesce((
              select jsonb_agg(b.n - 1 order by q.o)
              from jsonb_array_elements_text(p.entry -> 'roles') with ordinality as q(v, o)
              join jsonb_array_elements_text(t.r) with ordinality as b(v, n) on b.v = q.v
            ), '[]'::jsonb)
          else p.entry end as item
        from pdk_plain p, pdk_tables t
      ),
      pdk_fixed as (
        select used + octet_length(pdk_roles.held::text) + octet_length(pdk_tables.s::text) + octet_length(pdk_tables.r::text) + octet_length(pdk_tables.v::text) + 44 + octet_length(case jsonb_array_length(pdk_roles.held) when 0 then '' when 1 then (pdk_roles.held -> 0)::text else pdk_roles.held::text end) + coalesce(octet_length(to_jsonb(active)::text), 0) + 20 + octet_length(pdk_version.ver::text) as bytes from pdk_roles, pdk_version, pdk_tables
      ),
      pdk_ranked as (
        select x.entry, x.item, x.plain, x.root_id is not distinct from active as current,
          row_number() over w as n,
          sum(octet_length(x.item::text)) over w as bytes
        from pdk_items x
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
      (select case when count(*) = 0 then '[]'::jsonb else jsonb_strip_nulls(jsonb_build_object(
          's', nullif((select t.s from pdk_tables t), '[]'::jsonb), 'r', nullif((select t.r from pdk_tables t), '[]'::jsonb), 'v', nullif((select t.v from pdk_tables t), '[]'::jsonb),
          'e', nullif(coalesce(jsonb_agg(k.item order by k.n) filter (where k.plain), '[]'::jsonb), '[]'::jsonb),
          'o', nullif(coalesce(jsonb_agg(k.item order by k.n) filter (where not k.plain), '[]'::jsonb), '[]'::jsonb)
        )) end from pdk_kept k),
      truncated or (select count(*) from pdk_ranked) > (select count(*) from pdk_kept),
      active is not null and coalesce((select bool_or(k.current) from pdk_ranked k), false),
      (select bytes from pdk_fixed),
      (select pdk_version.ver from pdk_version)
    into held, kept, truncated, in_active, used, ver;
  end if;
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  claims := jsonb_set(claims, '{memberships}', kept);
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));
    claims := jsonb_set(claims, '{custom_roles_ver}', to_jsonb("permdock".custom_roles_version_for(active::uuid)));
  end if;
  extra := "public"."datetime_preference_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{datetime_preferences}', extra);
  end if;
  extra := "public"."feature_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{features}', extra);
  end if;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(ver));
  return jsonb_set(event, '{claims}', claims);
end;
$$;


create or replace function "permdock".permdock_subject(p_tenant text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  subject jsonb;
begin
  if p_tenant is null then
    return null;
  end if;
  begin
    v_tenant := p_tenant::uuid;
  exception when invalid_text_representation then
    return null;
  end;
  subject := "permdock".subject_for((select "permdock".permdock_user_id()), v_tenant);
  if subject is null
    or (subject ->> 'active') is distinct from 'true'
    or (coalesce(jsonb_array_length(subject -> 'memberships'), 0) = 0) then
    return null;
  end if;
  return subject || jsonb_build_object('tenant', v_tenant::text);
end;
$$;
revoke execute on function "permdock".permdock_subject(text) from public, anon, authenticated;
grant execute on function "permdock".permdock_subject(text) to authenticated;

create or replace function "permdock".authz_versions_for(p_user uuid, p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'authz', "permdock".authz_version_for(p_user),
    'custom_roles', "permdock".custom_roles_version_for(p_tenant)
  )
$$;
revoke execute on function "permdock".authz_versions_for(uuid, uuid) from public, anon, authenticated;
