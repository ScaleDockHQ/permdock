SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_approver_for_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  ROWS 5
  SET search_path TO ''
  AS $function$
  select (select "permdock".permdock_user_id())
  where (select "permdock".permdock_user_id()) is not null
  union
  select d.delegator
  from "permdock".approval_delegations d
  where d.delegate = (select "permdock".permdock_user_id())
    and d."from" <= now()
    and d."until" > now()
    and d.delegator <> (select "permdock".permdock_user_id())
    and d.tenant is null
    and d.permissions is null
    and d.resources is null
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approver_for_ids (
  p_tenant   text,
  p_resource text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  ROWS 5
  SET search_path TO ''
  AS $function$
  select (select "permdock".permdock_user_id())
  where (select "permdock".permdock_user_id()) is not null
  union
  select d.delegator
  from "permdock".approval_delegations d
  where d.delegate = (select "permdock".permdock_user_id())
    and d."from" <= now()
    and d."until" > now()
    and d.delegator <> (select "permdock".permdock_user_id())
    and (d.tenant is null or d.tenant::text = p_tenant)
    and d.permissions is null
    and (d.resources is null or p_resource = any (d.resources))
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_system_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if not current_user::text = any(array['anon', 'anonymous', 'authenticated']) then
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

CREATE TRIGGER permdock_custom_role_system_guard
  BEFORE INSERT OR UPDATE ON public.roles
  FOR EACH ROW
  EXECUTE FUNCTION permdock.permdock_custom_role_system_guard();

REVOKE ALL ON FUNCTION "permdock"."permdock_approver_for_ids"(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_approver_for_ids"(text, text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permdock_custom_role_system_guard"() FROM PUBLIC;
