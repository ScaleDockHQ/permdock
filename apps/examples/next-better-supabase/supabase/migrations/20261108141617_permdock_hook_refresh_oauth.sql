-- the hook reuses the memberships of a refresh whose authz_ver is current
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
    and jsonb_typeof(event -> 'claims' -> 'memberships') = 'array'
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
    in_active := active is not null and exists (
      select 1 from jsonb_array_elements(kept) as e(entry) where case when e.entry ->> 'scope' = 'organization' then e.entry ->> 'id' else e.entry -> 'within' ->> 'organization' end = active
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
      pdk_fixed as (
        select used + octet_length(pdk_roles.held::text) + octet_length(case jsonb_array_length(pdk_roles.held) when 0 then '' when 1 then (pdk_roles.held -> 0)::text else pdk_roles.held::text end) + coalesce(octet_length(to_jsonb(active)::text), 0) + 20 + octet_length(pdk_version.ver::text) as bytes from pdk_roles, pdk_version
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
