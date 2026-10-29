SET local check_function_bodies = off;

DROP FUNCTION "permdock"."permdock_cover_approves"(uuid, jsonb, text);

CREATE OR REPLACE FUNCTION permdock.permdock_cover_approves (
  p_delegator uuid,
  p_approvers jsonb,
  p_tenant    text,
  p_requester text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_item jsonb;
begin
  if p_delegator is null or p_approvers is null then
    return false;
  end if;
  if jsonb_typeof(p_approvers) = 'array' then
    if jsonb_array_length(p_approvers) = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_approvers) loop
      if not "permdock".permdock_cover_approves(p_delegator, v_item, p_tenant, p_requester) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if jsonb_typeof(p_approvers) <> 'object' then
    return false;
  end if;
  case p_approvers ->> 'kind'
    when 'user' then
      return coalesce(p_approvers ->> 'id' = p_delegator::text, false);
    when 'permission' then
      if p_tenant is null then
        return coalesce("permdock".permdock_has_permission_for(p_delegator, p_approvers ->> 'permission'), false);
      end if;
      return exists (
          select 1
          from "permdock".permitted_organization_ids_by_permission_for(p_delegator, p_approvers ->> 'permission') i(id)
          where i.id::text = p_tenant
        );
    when 'any-of' then
      if jsonb_typeof(p_approvers -> 'of') <> 'array' then
        return false;
      end if;
      for v_item in select value from jsonb_array_elements(p_approvers -> 'of') loop
        if "permdock".permdock_cover_approves(p_delegator, v_item, p_tenant, p_requester) then
          return true;
        end if;
      end loop;
      return false;
    else
      return false;
  end case;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_is_approver (
  p_approvers jsonb,
  p_tenant    text,
  p_requester text,
  p_resource  text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_delegator uuid;
  v_user text := (select "permdock".permdock_user_id())::text;
begin
  if "permdock".permdock_is_approver(p_approvers, p_tenant) then
    return true;
  end if;
  if coalesce(v_user, '') = '' or coalesce(p_requester, '') = '' then
    return false;
  end if;
  if p_tenant is not null and not (p_tenant in (select m.id::text from "permdock".member_organization_ids() m(id))) then
    return false;
  end if;
  for v_delegator in
    select d.delegator
    from "permdock".approval_delegations d
    where d.delegate::text = v_user
      and d.delegator::text <> v_user
      and d.delegator::text <> p_requester
      and d."from" <= now()
      and now() < d."until"
      and (d.tenant is null or d.tenant = p_tenant)
      and d.permissions is null
      and (d.resources is null or p_resource = any (d.resources))
  loop
    if "permdock".permdock_cover_approves(v_delegator, p_approvers, p_tenant, p_requester) then
      return true;
    end if;
  end loop;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_is_approver (
  p_approvers         jsonb,
  p_tenant            text,
  p_requester         text,
  p_resource          text,
  p_request_approvers jsonb
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select "permdock".permdock_is_approver(
    jsonb_build_object(
      'kind', 'any-of',
      'of',
      case when p_approvers is null then '[]'::jsonb else jsonb_build_array(p_approvers) end
        || case
          when jsonb_typeof(p_request_approvers -> 'users') = 'array' then coalesce(
            (select jsonb_agg(jsonb_build_object('kind', 'user', 'id', u.id)) from jsonb_array_elements_text(p_request_approvers -> 'users') u(id)),
            '[]'::jsonb
          )
          else '[]'::jsonb
        end
        || case when p_request_approvers -> 'manager' = 'true'::jsonb then '[{"kind": "manager"}]'::jsonb else '[]'::jsonb end
        || case
          when jsonb_typeof(p_request_approvers -> 'permission') = 'string'
            then jsonb_build_array(jsonb_build_object('kind', 'permission', 'permission', p_request_approvers ->> 'permission'))
          else '[]'::jsonb
        end
    ),
    p_tenant,
    p_requester,
    p_resource
  )
$function$;

REVOKE ALL ON FUNCTION "permdock"."permdock_cover_approves"(uuid, jsonb, text, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_is_approver"(jsonb, text, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_is_approver"(jsonb, text, text, text, jsonb) TO "authenticated";
