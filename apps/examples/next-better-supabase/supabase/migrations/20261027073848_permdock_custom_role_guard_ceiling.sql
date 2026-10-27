SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_sync_custom_role_guard_permissions()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v record;
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_lost text[];
  v_dropped text[];
  v_beyond text;
  v_refs text[] := array[
    case when tg_op <> 'INSERT' then old."role_id"::text end,
    case when tg_op <> 'DELETE' then new."role_id"::text end
  ];
begin
  if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '' and pg_trigger_depth() = 1) then
    return coalesce(new, old);
  end if;
  for v in
    select r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'organization' end as scope, null::text as scope_id, r."key"::text as role, r."id" as permissions_ref
    from "public"."roles" r
    where not (r."organization_id"::uuid is not null and coalesce(r."is_system", false)) and not (r."key"::text = any(array['contact', 'guest', 'member', 'owner']::text[])) and r."id"::text = any(v_refs)
  loop
    if v.role is null or not (v.scope = 'global' or v.scope = any(array['organization', 'customer']::text[])) then
      continue;
    end if;
    if v.tenant_id is not null and "permdock".permdock_is_shared_role(v.scope, v.role) then
      continue;
    end if;
    perform "permdock".permdock_custom_role_guard(v.tenant_id, v.scope, v.scope_id, v.role);
    if tg_op = 'DELETE' then
      continue;
    end if;
    v_dropped := '{}'::text[];
    with raw as (
      select x."permission"::text as legacy, 'allow' as effect, null::text as level
      from (select new.*) x
      where x."role_id" = v.permissions_ref
    ),
    mapped as (
      select n.legacy, n.legacy as key, n.effect, n.level
      from raw n
    ),
    judged as (
      select m.legacy, m.key, m.effect, m.level as level, case
          when m.effect not in ('allow', 'deny') then 'effect ' || m.effect || ' is not allow or deny'
          when m.key is null or not (m.key = any(array['audit.read', 'audit.revert', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])) then 'not a declared permission'
          when m.effect = 'allow' and not exists (select 1 from "permdock".permdock_ceiling c where c.scope = v.scope and c.effect = 'allow' and c.permission = m.key) then 'outside the ceiling of ' || v.scope
        end as dropped
      from mapped m
    )
    select array_agg(distinct j.key) filter (where j.dropped is null and j.effect = 'allow'),
      array_agg(distinct j.key) filter (where j.dropped is null and j.effect = 'deny'),
      array_agg(v.role || ': ' || coalesce(j.legacy, 'null') || ', ' || j.dropped) filter (where j.dropped is not null)
    into v_allow, v_deny, v_lost
    from judged j;
    v_dropped := v_dropped || coalesce(v_lost, '{}'::text[]);
    v_include := null;
    if cardinality(v_dropped) > 0 then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_dropped[1],
        hint = case
          when v_dropped[1] like '%outside the ceiling of %' then 'outside-ceiling'
          when v_dropped[1] like '%, level % is not declared' then 'unknown-level'
          when v_dropped[1] like '%, not a declared role' then 'unknown-role'
          else 'unknown-permission'
        end;
    end if;
    select string_agg(b, ', ' order by b) into v_beyond
    from "permdock".permdock_custom_role_beyond(v.tenant_id, v.scope, v.scope_id, v_allow, v_deny, v_include) b;
    if v_beyond is not null then
      raise exception using
        errcode = '42501',
        message = 'permdock: ' || v.role || ' would allow ' || v_beyond || ', which the caller may not hand out',
        hint = 'not-assignable-by';
    end if;
  end loop;
  return coalesce(new, old);
end;
$function$;
