SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_permission_keys()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select k.permission from unnest(array['quotes.list', 'quotes.read', 'quotes.update', 'staff.list', 'staff.read']::text[]) k(permission) order by 1
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_role_permissions (
  p_role     text,
  p_scope    text,
  p_tenant   uuid DEFAULT NULL::uuid,
  p_scope_id text DEFAULT NULL::text
)
  RETURNS TABLE (
    permission text,
    effect     text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform p_tenant, p_scope_id; -- only a custom role reads them
  return query
  select distinct rp.permission, rp.effect
  from "permdock".role_permissions rp
  where rp.role = p_role and rp.scope = p_scope
  order by 1, 2;
end;
$function$;

REVOKE ALL ON FUNCTION "permdock"."permdock_permission_keys"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_permission_keys"() TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permdock_role_permissions"(text, text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_role_permissions"(text, text, uuid, text) TO "authenticated";
