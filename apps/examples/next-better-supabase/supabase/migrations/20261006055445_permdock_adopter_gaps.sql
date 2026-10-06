SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.grant_keys (
  p_permission text,
  p_scope      text,
  p_effect     text DEFAULT 'allow'::text
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select g.grant_key
  from pg_catalog.jsonb_array_elements_text(coalesce(
    '{"customer":{"quotes.list":{"allow":["quotes.list"],"deny":[]},"quotes.read":{"allow":["quotes.read"],"deny":[]}},"organization":{"quotes.list":{"allow":["quotes.list"],"deny":[]},"quotes.read":{"allow":["quotes.read"],"deny":[]},"quotes.update":{"allow":["quotes.update"],"deny":[]},"staff.list":{"allow":["staff.list"],"deny":[]},"staff.read":{"allow":["staff.read"],"deny":[]}}}'::jsonb -> p_scope -> p_permission -> p_effect,
    '[]'::jsonb
  )) g(grant_key)
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has_for (
  p_user  uuid,
  p_grant text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select exists (
    select 1
    from "permdock".user_roles ur
    join "permdock".role_permissions rp on rp.role = ur.role::text
    where ur.user_id = p_user
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has_permission (
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select exists (select 1 from "permdock".grant_keys(p_permission, 'global') g(grant_key) where "permdock".permdock_has(g.grant_key))
    and not exists (select 1 from "permdock".grant_keys(p_permission, 'global', 'deny') g(grant_key) where "permdock".permdock_has(g.grant_key))
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has_permission_for (
  p_user       uuid,
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select exists (select 1 from "permdock".grant_keys(p_permission, 'global') g(grant_key) where "permdock".permdock_has_for(p_user, g.grant_key))
    and not exists (select 1 from "permdock".grant_keys(p_permission, 'global', 'deny') g(grant_key) where "permdock".permdock_has_for(p_user, g.grant_key))
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_by_permission (
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'customer') g(grant_key)
  cross join lateral "permdock".permitted_customer_ids(g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'customer', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_customer_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_by_permission_for (
  p_user       uuid,
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'customer') g(grant_key)
  cross join lateral "permdock".permitted_customer_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'customer', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_customer_ids_for(p_user, g.grant_key) d(id)
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
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
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

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_by_permission (
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'organization') g(grant_key)
  cross join lateral "permdock".permitted_organization_ids(g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_organization_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_by_permission_for (
  p_user       uuid,
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'organization') g(grant_key)
  cross join lateral "permdock".permitted_organization_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_organization_ids_for(p_user, g.grant_key) d(id)
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
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
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
  v_user_0 "public"."memberships"."user_id"%type := uid;
  v_user_1 "public"."contacts"."user_id"%type := uid;
  v_roles_user "permdock"."user_roles"."user_id"%type := uid;
begin
  if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
    return null;
  end if;
  select coalesce(jsonb_agg(distinct r."role"::text order by r."role"::text), '[]'::jsonb)
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
          'expiresAt', s.expires_at, 'grantedBy', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managedBy', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."memberships" m
        where m."user_id" = v_user_0
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
        where m."user_id" = v_user_1
        group by m."customer_id", m."organization_id"
      ) s
    ) x;
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  ver := coalesce(ver, 0);
  return jsonb_strip_nulls(jsonb_build_object(
    'id', uid::text,
    'active', true,
    'roles', held,
    'memberships', memberships,
    'customRoles', custom,
    'authzVersion', ver
  ));
end;
$function$;

REVOKE ALL ON FUNCTION "permdock"."grant_keys"(text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."grant_keys"(text, text, text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permdock_has_for"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_has_permission"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_has_permission"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permdock_has_permission_for"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_customer_ids_by_permission"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_customer_ids_by_permission"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_customer_ids_by_permission_for"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_customer_ids_for"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_ids_by_permission"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_organization_ids_by_permission"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_ids_by_permission_for"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_ids_for"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."subject_for"(uuid) FROM PUBLIC;
