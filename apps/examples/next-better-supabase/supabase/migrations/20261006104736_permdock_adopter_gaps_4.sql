SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.authz_version_for (
  p_user uuid
)
  RETURNS bigint
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := p_user;
  ver bigint;
begin
  if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
    return null;
  end if;
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  ver := coalesce(ver, 0);
  return ver;
end;
$function$;

REVOKE ALL ON FUNCTION "permdock"."authz_version_for"(uuid) FROM PUBLIC;
