SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select k.key
  from pg_catalog.unnest(array['quotes.list', 'quotes.read']::text[]) k(key)
  where "permdock".permdock_has_permission(k.key)
    or p_id in (select "permdock".permitted_customer_ids_by_permission(k.key))
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys_for (
  p_user uuid,
  p_id   uuid
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select k.key
  from pg_catalog.unnest(array['quotes.list', 'quotes.read']::text[]) k(key)
  where "permdock".permdock_has_permission_for(p_user, k.key)
    or p_id in (select "permdock".permitted_customer_ids_by_permission_for(p_user, k.key))
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select k.key
  from pg_catalog.unnest(array['quotes.list', 'quotes.read', 'quotes.update', 'staff.list', 'staff.read']::text[]) k(key)
  where "permdock".permdock_has_permission(k.key)
    or p_id in (select "permdock".permitted_organization_ids_by_permission(k.key))
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select k.key
  from pg_catalog.unnest(array['quotes.list', 'quotes.read', 'quotes.update', 'staff.list', 'staff.read']::text[]) k(key)
  where "permdock".permdock_has_permission_for(p_user, k.key)
    or p_id in (select "permdock".permitted_organization_ids_by_permission_for(p_user, k.key))
$function$;

REVOKE ALL ON FUNCTION "permdock"."permitted_customer_permission_keys"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_customer_permission_keys"(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_customer_permission_keys_for"(uuid, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_permission_keys"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_organization_permission_keys"(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_permission_keys_for"(uuid, uuid) FROM PUBLIC;
