SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION better_supabase.portal_subjects (
  action text
)
  RETURNS TABLE (
    tenant text,
    subject_type text,
    subject_id text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select null::text, null::text, null::text where false
$function$;
