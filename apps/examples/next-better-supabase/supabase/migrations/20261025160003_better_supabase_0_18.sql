SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION better_supabase.organization_member_roles (
  organization uuid,
  member       uuid
)
  RETURNS text[]
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select array[m."role"]::text[]
  from "public"."organization_memberships" m where m."organization_id" = organization_member_roles.organization and m."user_id" = organization_member_roles.member and m."organization_id" in (select p.id from permdock.member_organization_ids_for(organization_member_roles.member) as p(id))
$function$;

CREATE OR REPLACE FUNCTION better_supabase.request_ip()
  RETURNS inet
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  return nullif(trim(reverse(split_part(reverse(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for'), ',', 1))), '')::inet;
exception when others then
  return null;
end;
$function$;

REVOKE ALL ON FUNCTION "better_supabase"."organization_member_roles"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."organization_member_roles"(uuid, uuid) TO "service_role";
