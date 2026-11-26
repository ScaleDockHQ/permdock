SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.member_team_ids_for (
  p_user   uuid,
  p_active text DEFAULT NULL::text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select null::uuid where false -- no team memberships table configured
$function$;

REVOKE ALL ON FUNCTION "permdock"."member_team_ids_for"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."member_team_ids_for"(uuid, text) TO "supabase_auth_admin";
