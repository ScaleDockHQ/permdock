SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_approver_matches (
  p_approvers jsonb,
  p_tenant    text,
  p_requester text,
  p_user      text,
  p_facts     jsonb
)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path TO ''
  AS $function$
declare
  v_item jsonb;
begin
  if p_approvers is null then
    return false;
  end if;
  if jsonb_typeof(p_approvers) = 'array' then
    if jsonb_array_length(p_approvers) = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_approvers) loop
      if not "permdock".permdock_approver_matches(v_item, p_tenant, p_requester, p_user, p_facts) then
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
      return coalesce(p_approvers ->> 'id' = p_user, false);
    when 'permission' then
      if p_tenant is null then
        return coalesce((p_facts -> 'global' ->> (p_approvers ->> 'permission'))::boolean, false);
      end if;
      return coalesce(p_facts -> 'within' -> (p_approvers ->> 'permission') ? p_tenant, false);
    when 'any-of' then
      if jsonb_typeof(p_approvers -> 'of') <> 'array' then
        return false;
      end if;
      for v_item in select value from jsonb_array_elements(p_approvers -> 'of') loop
        if "permdock".permdock_approver_matches(v_item, p_tenant, p_requester, p_user, p_facts) then
          return true;
        end if;
      end loop;
      return false;
    else
      return false;
  end case;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approver_request_ids (
  p_requests jsonb,
  p_kinds    jsonb,
  p_current  boolean DEFAULT false
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  ROWS 10
  SET search_path TO ''
  AS $function$
declare
  v_user text := (select "permdock".permdock_user_id())::text;
  v_requests jsonb;
  v_request jsonb;
  v_facts jsonb;
  v_covers jsonb;
  v_member text[];
  v_delegator uuid;
begin
  if coalesce(v_user, '') = '' or jsonb_typeof(p_requests) is distinct from 'array' then
    return;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'within', r.within,
      'requester', r.requester,
      'resource', r.resource,
      'approvers', case when p_current then
        jsonb_build_object(
          'kind', 'any-of',
          'of',
          case when r.approvers is null then '[]'::jsonb else jsonb_build_array(r.approvers) end
            || case
              when jsonb_typeof(r.current -> 'users') = 'array' then coalesce(
                (select jsonb_agg(jsonb_build_object('kind', 'user', 'id', u.id)) from jsonb_array_elements_text(r.current -> 'users') u(id)),
                '[]'::jsonb
              )
              else '[]'::jsonb
            end
            || case when r.current -> 'manager' = 'true'::jsonb then '[{"kind": "manager"}]'::jsonb else '[]'::jsonb end
            || case
              when jsonb_typeof(r.current -> 'permission') = 'string'
                then jsonb_build_array(jsonb_build_object('kind', 'permission', 'permission', r.current ->> 'permission'))
              else '[]'::jsonb
            end
        )
        else r.approvers end
    )), '[]'::jsonb)
  into v_requests
  from (
    select e ->> 'id' as id,
      e ->> 'tenant' as within,
      e ->> 'requester' as requester,
      case when k.listed then case when strpos(e ->> 'kind', '.') > 1 then split_part(e ->> 'kind', '.', 1) else e ->> 'kind' end else split_part(e ->> 'kind', '.', 1) end as resource,
      case when k.listed then p_kinds -> (e ->> 'kind') end as approvers,
      e -> 'approvers' as current,
      k.listed
    from jsonb_array_elements(p_requests) e,
      lateral (select coalesce(jsonb_typeof(p_kinds) = 'object' and p_kinds ? (e ->> 'kind'), false) as listed) k
    where jsonb_typeof(e) = 'object' and e ->> 'id' is not null
  ) r
  where r.listed or p_current;
  if jsonb_array_length(v_requests) = 0 then
    return;
  end if;
  with leaves as (
    select r ->> 'within' as within, l ->> 'permission' as permission
    from jsonb_array_elements(v_requests) r, jsonb_path_query(r -> 'approvers', 'strict $.** ? (@.kind == "permission")') l
  )
  select jsonb_build_object(
    'global', (
      select coalesce(jsonb_object_agg(p.permission, coalesce("permdock".permdock_has_permission(p.permission), false)), '{}'::jsonb)
      from (select distinct l.permission from leaves l where l.within is null and l.permission is not null) p
    ),
    'within', (
      select coalesce(jsonb_object_agg(p.permission, (
        select coalesce(jsonb_agg(i.id::text), '[]'::jsonb)
        from "permdock".permitted_organization_ids_by_permission(p.permission) i(id)
      )), '{}'::jsonb)
      from (select distinct l.permission from leaves l where l.within is not null and l.permission is not null) p
    )
  )
  into v_facts;
  for v_request in select value from jsonb_array_elements(v_requests) loop
    if "permdock".permdock_approver_matches(v_request -> 'approvers', v_request ->> 'within', v_request ->> 'requester', v_user, v_facts) then
      return next v_request ->> 'id';
      continue;
    end if;
    if coalesce(v_request ->> 'requester', '') = '' then
      continue;
    end if;
    if v_covers is null then
      select coalesce(jsonb_agg(jsonb_build_object('delegator', d.delegator, 'within', d.tenant, 'resources', d.resources)), '[]'::jsonb)
      into v_covers
      from "permdock".approval_delegations d
      where d.delegate = v_user::uuid
        and d.delegator::text <> v_user
        and d."from" <= now()
        and now() < d."until"
        and d.permissions is null;
    end if;
    if jsonb_array_length(v_covers) = 0 then
      continue;
    end if;
    if v_request ->> 'within' is not null then
      if v_member is null then
        select coalesce(array_agg(m.id::text), '{}') into v_member from "permdock".member_organization_ids() m(id);
      end if;
      if not (v_request ->> 'within' = any (v_member)) then
        continue;
      end if;
    end if;
    for v_delegator in
      select (c ->> 'delegator')::uuid
      from jsonb_array_elements(v_covers) c
      where c ->> 'delegator' <> v_request ->> 'requester'
        and (c ->> 'within' is null or c ->> 'within' = v_request ->> 'within')
        and (c ->> 'resources' is null or c -> 'resources' ? (v_request ->> 'resource'))
    loop
      if "permdock".permdock_cover_approves(v_delegator, v_request -> 'approvers', v_request ->> 'within', v_request ->> 'requester') then
        return next v_request ->> 'id';
        exit;
      end if;
    end loop;
  end loop;
end;
$function$;

REVOKE ALL ON FUNCTION "permdock"."permdock_approver_matches"(jsonb, text, text, text, jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_approver_request_ids"(jsonb, jsonb, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_approver_request_ids"(jsonb, jsonb, boolean) TO "authenticated";
