SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.custom_access_token_hook (
  event jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
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
  v_user_0 "public"."memberships"."user_id"%type := uid;
  v_user_1 "public"."contacts"."user_id"%type := uid;
  v_roles_user "permdock"."user_roles"."user_id"%type := uid;
  extra jsonb;
  ver bigint;
begin
  claims := claims - 'attrs' - 'datetime_preferences' - 'features';
  select coalesce(jsonb_agg(distinct r."role"::text order by r."role"::text) filter (where r."role"::text is not null), '[]'::jsonb)
    into held
    from "permdock"."user_roles" r
    where r."user_id" = v_roles_user;
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := claims -> 'app_metadata' ->> 'active_organization';
  for item in
    select x.entry, x.tenant is not distinct from active as current
    from (
      select 0 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managed_by', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."memberships" m
        where m."user_id" = v_user_0
        group by m."scope"::text, m."scope_id"::text
        having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
      ) s
      union all
      select 1 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managed_by', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."contacts" m
        where m."user_id" = v_user_1
        group by m."customer_id", m."organization_id"
        having jsonb_build_array('contact') is not null
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
  extra := "public"."datetime_preference_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{datetime_preferences}', extra);
  end if;
  extra := "public"."feature_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{features}', extra);
  end if;
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(coalesce(ver, 0)));
  return jsonb_set(event, '{claims}', claims);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_customer_ids()
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
  v_user_1 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select distinct (ms.id)::uuid
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
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_customer_ids_for (
  p_user uuid
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
  v_user_1 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  select distinct (ms.id)::uuid
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
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_organization_ids()
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_organization_ids_for (
  p_user uuid
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.members_of (
  p_scope text,
  p_id    text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
      select m."user_id"::text as user_id, m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."memberships" m
      where m."scope"::text = $1::text and m."scope_id"::text = $2::text
      group by m."user_id", m."scope"::text, m."scope_id"::text
      having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
      union all
      select m."user_id"::text as user_id, 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."contacts" m
      where $1::text = 'customer' and m."customer_id"::text = $2::text
      group by m."user_id", m."customer_id", m."organization_id"
      having jsonb_build_array('contact') is not null
  ) s
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_for (
  p_user  uuid,
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
    and rp.scope = 'customer';
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys (
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys_for (
  p_user uuid,
  p_id   uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys_for (
  p_user uuid,
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_for (
  p_user  uuid,
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
    and rp.scope = 'organization';
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION permdock.subject_for (
  p_user uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := p_user;
  held jsonb;
  memberships jsonb;
  custom jsonb := '[]'::jsonb;
  ver bigint;
  claims jsonb := '{}'::jsonb;
  extra jsonb;
  v_user_0 "public"."memberships"."user_id"%type := uid;
  v_user_1 "public"."contacts"."user_id"%type := uid;
  v_roles_user "permdock"."user_roles"."user_id"%type := uid;
begin
  if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
    return null;
  end if;
  select coalesce(jsonb_agg(distinct r."role"::text order by r."role"::text) filter (where r."role"::text is not null), '[]'::jsonb)
    into held
    from "permdock"."user_roles" r
    where r."user_id" = v_roles_user;
  select coalesce(jsonb_agg(x.entry order by x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text), '[]'::jsonb)
    into memberships
    from (
      select 0 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managed_by', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."memberships" m
        where m."user_id" = v_user_0
        group by m."scope"::text, m."scope_id"::text
        having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
      ) s
      union all
      select 1 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managed_by', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."contacts" m
        where m."user_id" = v_user_1
        group by m."customer_id", m."organization_id"
        having jsonb_build_array('contact') is not null
      ) s
    ) x;
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  ver := coalesce(ver, 0);
  extra := "public"."datetime_preference_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{datetime_preferences}', extra);
  end if;
  extra := "public"."feature_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{features}', extra);
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
$function$;
