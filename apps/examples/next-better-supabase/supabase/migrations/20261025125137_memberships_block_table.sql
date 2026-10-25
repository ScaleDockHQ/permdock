SET local check_function_bodies = off;

DROP VIEW "public"."organization_memberships";

CREATE TABLE "public"."organization_memberships" (
  "organization_id" uuid                     NOT NULL,
  "user_id"         uuid                     NOT NULL,
  "role"            text                     NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "organization_memberships_pkey" PRIMARY KEY (organization_id, user_id)
);

-- One role per member: the earliest organization role wins, as the view chose it.
-- Rows of a deleted organization would fail the new foreign key.
INSERT INTO "public"."organization_memberships" (organization_id, user_id, role, created_at)
SELECT DISTINCT ON (scope_id, user_id) scope_id, user_id, role, created_at
FROM "public"."memberships"
WHERE scope = 'organization' AND scope_id IN (SELECT id FROM "public"."organizations")
ORDER BY scope_id, user_id, created_at, role;

ALTER TABLE "public"."memberships"
  DROP CONSTRAINT "memberships_user_id_fkey";

DROP TABLE "public"."memberships";

ALTER TABLE "public"."organization_memberships"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."organization_memberships" FROM "anon";

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
  v_user_0 "public"."organization_memberships"."user_id"%type := uid;
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
        select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."organization_memberships" m
        where m."user_id" = v_user_0
        group by m."organization_id"
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
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
  v_user_0 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
      select m."user_id"::text as user_id, 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."organization_memberships" m
      where $1::text = 'organization' and m."organization_id"::text = $2::text
      group by m."user_id", m."organization_id"
      having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
      union all
      select m."user_id"::text as user_id, 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."contacts" m
      where $1::text = 'customer' and m."customer_id"::text = $2::text
      group by m."user_id", m."customer_id", m."organization_id"
      having jsonb_build_array('contact') is not null
  ) s
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_holders_organization()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_ids text[] := '{}';
  v_id text;
  v_key_0 "public"."organization_memberships"."organization_id"%type;
  v_total bigint;
  v_count bigint;
begin
  if tg_relid = '"public"."organization_memberships"'::regclass then
    if tg_op in ('UPDATE', 'DELETE') then
      v_ids := v_ids || old."organization_id"::text;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      v_ids := v_ids || new."organization_id"::text;
    end if;
  end if;
  foreach v_id in array v_ids loop
    continue when v_id is null;
    v_key_0 := v_id;
    select count(*) into v_total
      from (
        select m."organization_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."organization_memberships" m
        where m."organization_id" = v_key_0
      ) h;
    select count(distinct h.user_id) into v_count
      from (
        select m."organization_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."organization_memberships" m
        where m."organization_id" = v_key_0
      ) h
      where h.live
        and h.role = 'owner';
    if v_total > 0 and v_count < 1 then
      raise exception using
        errcode = '23514',
        message = 'permdock: organization ' || v_id || ' keeps at least 1 owner',
        hint = 'last-holder';
    end if;
  end loop;
  return null;
end;
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
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
  v_user_0 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  select (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
  v_user_0 "public"."contacts"."user_id"%type := p_user;
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
  v_user_0 "public"."contacts"."user_id"%type := p_user;
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_users (
  p_permission text,
  p_id         uuid
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_key_0 "public"."contacts"."customer_id"%type := p_id;
begin
  return query
    select c.user_id
    from (
      select h.user_id::uuid
      from (
        select m."customer_id"::text as id, m."user_id"::text as user_id, mf.role as role, 'contact'::text as via, true as live
        from "public"."contacts" m cross join lateral unnest(array['contact']::text[]) mf(role)
        where m."customer_id" = v_key_0
      ) h
      union
      select ur.user_id::uuid
      from "permdock".user_roles ur
    ) c(user_id)
    where c.user_id is not null
      and (
        p_id in (select "permdock".permitted_customer_ids_by_permission_for(c.user_id, p_permission))
        or "permdock".permdock_has_permission_for(c.user_id, p_permission)
      )
    order by 1;
end
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
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  select (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('roles.manage', 'organization', 'allow', 'roles.manage'),
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('roles.manage', 'organization', 'allow', 'roles.manage'),
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('roles.manage', 'organization', 'allow', 'roles.manage'),
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('roles.manage', 'organization', 'allow', 'roles.manage'),
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_users (
  p_permission text,
  p_id         uuid
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_key_0 "public"."organization_memberships"."organization_id"%type := p_id;
begin
  return query
    select c.user_id
    from (
      select h.user_id::uuid
      from (
        select m."organization_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."organization_memberships" m
        where m."organization_id" = v_key_0
      ) h
      union
      select ur.user_id::uuid
      from "permdock".user_roles ur
    ) c(user_id)
    where c.user_id is not null
      and (
        p_id in (select "permdock".permitted_organization_ids_by_permission_for(c.user_id, p_permission))
        or "permdock".permdock_has_permission_for(c.user_id, p_permission)
      )
    order by 1;
end
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
  v_user_0 "public"."organization_memberships"."user_id"%type := uid;
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
        select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."organization_memberships" m
        where m."user_id" = v_user_0
        group by m."organization_id"
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
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'name', c.role,
      'shared', case when c.tenant_id is null and c.scope <> 'global' then true end,
      'tenant', c.tenant_id::text,
      'scope', c.scope,
      'id', c.scope_id,
      'grants', (
        select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'permission', p.permission,
            'effect', p.effect,
            'level', to_jsonb(p) ->> 'level'
          )) order by p.permission, p.effect), '[]'::jsonb)
        from "permdock".custom_role_permissions p
        where p.tenant_id is not distinct from c.tenant_id and p.scope = c.scope and p.scope_id is not distinct from c.scope_id and p.role = c.role
      ),
      'includes', (
        select jsonb_agg(p.include_role order by p.include_role)
        from "permdock".custom_role_includes p
        where p.tenant_id is not distinct from c.tenant_id and p.scope = c.scope and p.scope_id is not distinct from c.scope_id and p.role = c.role
      )
    )) order by c.tenant_id::text, c.scope, c.scope_id, c.role), '[]'::jsonb)
    into custom
    from (
      select tenant_id, scope, scope_id, role from "permdock".custom_role_permissions
      union
      select tenant_id, scope, scope_id, role from "permdock".custom_role_includes
    ) c
    where (c.scope = 'global' and c.tenant_id is null and held ? c.role)
      or exists (
        select 1
        from jsonb_array_elements(memberships) m
        where m -> 'roles' ? c.role
          and m ->> 'scope' = c.scope
          and (
            (c.tenant_id is null and c.scope_id is null)
            or c.tenant_id::text = case when m ->> 'scope' = 'organization' then m ->> 'id' else m -> 'within' ->> 'organization' end
          )
          and (c.scope_id is null or c.scope_id = m ->> 'id')
      );
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

ALTER TABLE "public"."organization_memberships"
  ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE "public"."organization_memberships"
  ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX memberships_user_idx ON public.organization_memberships USING btree (user_id);

CREATE TRIGGER bsb_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.organization_memberships
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_row_change();

CREATE TRIGGER permdock_authz_version
  AFTER INSERT OR DELETE OR UPDATE ON public.organization_memberships
  FOR EACH ROW
  EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');

CREATE CONSTRAINT TRIGGER permdock_holders_organization
  AFTER INSERT OR DELETE OR UPDATE ON public.organization_memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION permdock.permdock_holders_organization();

CREATE POLICY "organization_memberships_read" ON "public"."organization_memberships"
  FOR SELECT
  TO "authenticated"
  USING (((user_id = ( SELECT auth.uid() AS uid)) OR (organization_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids))));

CREATE POLICY "bsb_tenant_scope" ON "public"."organization_memberships"
  AS RESTRICTIVE
  FOR ALL
  TO "authenticated"
  USING
    (((organization_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR ((user_id = ( SELECT auth.uid() AS uid)) OR (organization_id IN (
    SELECT better_supabase.member_organization_ids() AS member_organization_ids)))))
  WITH CHECK ((organization_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "permdock_auth_admin_read_memberships" ON "public"."organization_memberships"
  FOR SELECT
  TO "supabase_auth_admin"
  USING (true);

REVOKE ALL ON TABLE "public"."organization_memberships" FROM "authenticated";

GRANT SELECT ON TABLE "public"."organization_memberships" TO "authenticated";

REVOKE ALL ON TABLE "public"."organization_memberships" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."organization_memberships" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."organization_memberships" TO "service_role";

GRANT SELECT ON TABLE "public"."organization_memberships" TO "supabase_auth_admin";
