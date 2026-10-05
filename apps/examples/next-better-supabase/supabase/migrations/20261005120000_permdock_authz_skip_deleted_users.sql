SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_bump_authz_version_for (
  p_users uuid[]
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  insert into "permdock"."permdock_authz_version" as v (user_id, version)
  select distinct u, 1 from unnest(p_users) u
  where u is not null and exists (select 1 from auth.users au where au.id = u)
  on conflict (user_id) do update set version = v.version + 1
$function$;
