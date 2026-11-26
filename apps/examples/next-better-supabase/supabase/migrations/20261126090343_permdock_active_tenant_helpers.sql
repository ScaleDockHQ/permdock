SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_organization_has_active (
  p_grant text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  COST 1000
  SET search_path TO ''
  AS $function$
  select "permdock".permdock_organization_has(p_grant, nullif(((select auth.jwt()) ->> 'tenant_id'), '')::uuid)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_active (
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  COST 1000
  SET search_path TO ''
  AS $function$
  select "permdock".permitted_organization_permission_keys(nullif(((select auth.jwt()) ->> 'tenant_id'), '')::uuid, p_keys)
$function$;

REVOKE ALL ON FUNCTION "permdock"."permdock_organization_has_active"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_organization_has_active"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_permission_keys_active"(text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_organization_permission_keys_active"(text[]) TO "authenticated";
