SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION better_supabase.permission_matches (
  granted text,
  wanted  text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select granted = wanted
$function$;

CREATE OR REPLACE FUNCTION better_supabase.portal_parties()
  RETURNS TABLE (
    tenant     text,
    party_type text,
    party_id   text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select g.tenant::text, g.party_type::text, g.party_id::text from (select m.organization_id::text, 'customer', m.customer_id::text from public.contacts m where m.customer_id in (select permdock.member_customer_ids())) as g(tenant, party_type, party_id)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.portal_subjects (
  action text
)
  RETURNS TABLE (
    tenant       text,
    subject_type text,
    subject_id   text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select g.tenant::text, g.subject_type::text, g.subject_id::text from (select m.organization_id::text, 'customer', m.customer_id::text from public.contacts m where m.customer_id in (select permdock.member_customer_ids()) and m.customer_id in (select permdock.permitted_customer_ids_by_permission('customer.' || portal_subjects.action))) as g(tenant, subject_type, subject_id)
$function$;

REVOKE ALL ON FUNCTION "better_supabase"."portal_parties"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."portal_parties"() TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."portal_subjects"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."portal_subjects"(text) TO "authenticated", "service_role";
