SET local check_function_bodies = off;

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
        'expiresAt', s.expires_at, 'grantedBy', s.granted_by, 'reason', s.reason,
        'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
        'managedBy', s.managed_by, 'entitlements', s.seats
      ))
    ) order by s.user_id, s.roles::text), '[]'::jsonb)
  from (
      select m."user_id"::text as user_id, m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."memberships" m
      where m."scope"::text = $1::text and m."scope_id"::text = $2::text
      group by m."user_id", m."scope"::text, m."scope_id"::text
      union all
      select m."user_id"::text as user_id, 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."contacts" m
      where $1::text = 'customer' and m."customer_id"::text = $2::text
      group by m."user_id", m."customer_id", m."organization_id"
  ) s
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_by_permission (
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_customer_ids(g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_customer_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_by_permission_for (
  p_user        uuid,
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_customer_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_customer_ids_for(p_user, g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_by_permission (
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_organization_ids(g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_organization_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_by_permission_for (
  p_user        uuid,
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_organization_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_organization_ids_for(p_user, g.grant_key) d(id)
$function$;

REVOKE ALL ON FUNCTION "permdock"."members_of"(text, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_customer_ids_by_permission"(text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_customer_ids_by_permission"(text, boolean) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_customer_ids_by_permission_for"(uuid, text, boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_ids_by_permission"(text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_organization_ids_by_permission"(text, boolean) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_ids_by_permission_for"(uuid, text, boolean) FROM PUBLIC;
