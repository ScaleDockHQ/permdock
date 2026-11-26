SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_system_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if not current_user::text = any(array['anon', 'anonymous', 'authenticated']) then
    return new;
  end if;
  if new."organization_id" is null and (tg_op = 'INSERT' or old."organization_id" is null) then
    return new;
  end if;
  if (tg_op = 'INSERT' and coalesce(new."is_system", false))
    or (tg_op = 'UPDATE' and (
      coalesce(new."is_system", false) is distinct from coalesce(old."is_system", false)
      or (coalesce(old."is_system", false) and (new."key"::text is distinct from old."key"::text or new."organization_id" is distinct from old."organization_id"))
    )) then
    raise exception using
      errcode = '42501',
      hint = 'system-role',
      message = 'permdock: only trusted SQL writes a system role';
  end if;
  return new;
end;
$function$;
