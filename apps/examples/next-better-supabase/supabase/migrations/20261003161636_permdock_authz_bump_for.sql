SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_bump_authz_version()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  column_name text := tg_argv[0];
begin
  perform "permdock".permdock_bump_authz_version_for(array[
    case when tg_op <> 'INSERT' then to_jsonb(old) ->> column_name end,
    case when tg_op <> 'DELETE' then to_jsonb(new) ->> column_name end
  ]::uuid[]);
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_bump_authz_version_for (
  p_users uuid[]
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  insert into "permdock"."permdock_authz_version" as v (user_id, version)
  select distinct u, 1 from unnest(p_users) u where u is not null
  on conflict (user_id) do update set version = v.version + 1
$function$;

REVOKE ALL ON FUNCTION "permdock"."permdock_bump_authz_version_for"(uuid[]) FROM PUBLIC;
