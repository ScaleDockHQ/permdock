SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION better_supabase.tenant_disabled (
  tenant uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select not exists (select 1 from "public"."organizations" t where t."id" = tenant_disabled.tenant and t."status"::text in ('active'))
$function$;
