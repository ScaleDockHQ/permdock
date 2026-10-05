SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_holders_organization()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_ids text[] := '{}';
  v_id text;
  v_key_0 "public"."memberships"."scope_id"%type;
  v_total bigint;
  v_count bigint;
begin
  if tg_relid = '"public"."memberships"'::regclass then
    if tg_op in ('UPDATE', 'DELETE') then
      v_ids := v_ids || case when old."scope"::text = 'organization' then old."scope_id"::text end;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      v_ids := v_ids || case when new."scope"::text = 'organization' then new."scope_id"::text end;
    end if;
  end if;
  foreach v_id in array v_ids loop
    continue when v_id is null;
    v_key_0 := v_id;
    select count(*) into v_total
      from (
        select m."scope_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."memberships" m
        where m."scope"::text = 'organization' and m."scope_id" = v_key_0
      ) h;
    select count(distinct h.user_id) into v_count
      from (
        select m."scope_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."memberships" m
        where m."scope"::text = 'organization' and m."scope_id" = v_key_0
      ) h
      where h.live
        and h.role = 'owner';
    if v_total > 0 and v_count < 1 then
      raise exception using
        errcode = '23514',
        message = 'permdock: organization ' || v_id || ' keeps at least 1 owner',
        hint = 'last-holder';
    end if;
  end loop;
  return null;
end;
$function$;

CREATE CONSTRAINT TRIGGER permdock_holders_organization
  AFTER INSERT OR DELETE OR UPDATE ON public.memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION permdock.permdock_holders_organization();
