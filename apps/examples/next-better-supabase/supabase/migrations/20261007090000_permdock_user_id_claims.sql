SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_user_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid
$function$;
