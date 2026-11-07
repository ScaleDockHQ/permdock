SET local check_function_bodies = off;

DROP FUNCTION "permdock"."permdock_approver_for_ids"();

CREATE OR REPLACE FUNCTION permdock.permdock_approver_for_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
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
$function$;

REVOKE ALL ON FUNCTION "permdock"."permdock_approver_for_ids"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_approver_for_ids"() TO "authenticated";
