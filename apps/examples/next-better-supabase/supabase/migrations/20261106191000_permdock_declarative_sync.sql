SET local check_function_bodies = off;

DROP FUNCTION "permdock"."membership_entries_for"(uuid);

CREATE OR REPLACE FUNCTION permdock.custom_access_token_hook (
  event jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  claims jsonb := event -> 'claims';
  uid uuid := (event ->> 'user_id')::uuid;
  active text;
  held jsonb;
  kept jsonb := '[]'::jsonb;
  truncated boolean := false;
  in_active boolean := false;
  budget integer := 1024;
  used integer := 0;
  item record;
  extra jsonb;
  ver bigint;
begin
  claims := claims - 'attrs' - 'datetime_preferences' - 'features';
  held := "permdock".global_roles_for(uid);
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := claims -> 'app_metadata' ->> 'tenant_id';
  for item in
    select x.entry, x.root_id is not distinct from active as current
    from (
      select e.ord, e.entry, case when e.entry ->> 'scope' = 'organization' then e.entry ->> 'id' else e.entry -> 'within' ->> 'organization' end as root_id
      from "permdock".memberships_for(uid) e
    ) x
    order by (x.root_id is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
  loop
    if octet_length((kept || jsonb_build_array(item.entry))::text) + used > budget then
      truncated := true;
      exit;
    end if;
    kept := kept || jsonb_build_array(item.entry);
    in_active := in_active or (active is not null and item.current);
  end loop;
  claims := jsonb_set(claims, '{memberships}', kept);
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));
  end if;
  extra := "public"."datetime_preference_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{datetime_preferences}', extra);
  end if;
  extra := "public"."feature_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{features}', extra);
  end if;
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(coalesce(ver, 0)));
  return jsonb_set(event, '{claims}', claims);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.memberships_for (
  p_user uuid
)
  RETURNS TABLE (
    ord   integer,
    entry jsonb
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
  v_user_1 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  select x.ord, x.entry
  from (
    select 0 as ord,
      (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
      jsonb_strip_nulls(jsonb_build_object(
        'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
        'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
        'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
        'managed_by', s.managed_by, 'entitlements', s.seats
      )) as entry
    from (
      select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."organization_memberships" m
      where m."user_id" = v_user_0
      group by m."organization_id"
      having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    ) s
    union all
    select 1 as ord,
      (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
      jsonb_strip_nulls(jsonb_build_object(
        'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
        'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
        'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
        'managed_by', s.managed_by, 'entitlements', s.seats
      )) as entry
    from (
      select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
      from "public"."contacts" m
      where m."user_id" = v_user_1
      group by m."customer_id", m."organization_id"
      having jsonb_build_array('contact') is not null
    ) s
  ) x;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approver_for_ids()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select (select "permdock".permdock_user_id())::text
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
  union
  select d.delegator::text
  from "permdock".approval_delegations d
  where d.delegate::text = (select "permdock".permdock_user_id())::text
    and d."from" <= now()
    and d."until" > now()
    and d.delegator::text <> (select "permdock".permdock_user_id())::text
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_cascade_custom_role()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_old_tenant uuid := old."organization_id"::uuid;
  v_old_scope text := case when old."organization_id"::uuid is null then 'global' else 'organization' end;
  v_old_id text := null::text;
  v_old_key text := old."key"::text;
  v_new_tenant uuid;
  v_new_scope text;
  v_new_id text;
  v_new_key text;
  v_checked boolean := coalesce((select "permdock".permdock_user_id())::text, '') <> '' and current_setting('permdock.sync', true) is distinct from 'on';
  v_allow text[];
  v_deny text[];
  v_include text[];
begin
  if (old."organization_id"::uuid is not null and coalesce(old."is_system", false)) then
    return null;
  end if;
  if tg_op = 'UPDATE' and not (new."organization_id"::uuid is not null and coalesce(new."is_system", false)) then
    v_new_tenant := new."organization_id"::uuid;
    v_new_scope := case when new."organization_id"::uuid is null then 'global' else 'organization' end;
    v_new_id := null::text;
    v_new_key := new."key"::text;
    if v_new_key = v_old_key
      and v_new_tenant is not distinct from v_old_tenant
      and v_new_scope = v_old_scope
      and v_new_id is not distinct from v_old_id then
      return null;
    end if;
  end if;
  if not exists (select 1 from "permdock".custom_role_permissions c where c.tenant_id is not distinct from v_old_tenant and c.scope = v_old_scope and c.scope_id is not distinct from v_old_id and c.role = v_old_key)
    and not exists (select 1 from "permdock".custom_role_includes c where c.tenant_id is not distinct from v_old_tenant and c.scope = v_old_scope and c.scope_id is not distinct from v_old_id and c.role = v_old_key) then
    return null;
  end if;
  if v_checked then
    perform "permdock".permdock_custom_role_guard(v_old_tenant, v_old_scope, v_old_id, v_old_key);
  end if;
  if v_new_key is null then
    perform set_config('permdock.sync', 'on', true);
    perform "permdock".permdock_trusted_delete_custom_role_grants(v_old_tenant, v_old_scope, v_old_id, v_old_key);
    delete from "permdock".custom_role_includes c
    where c.include_role = v_old_key
      and not (v_old_key = any(array['contact', 'guest', 'member', 'owner']::text[]));
    perform set_config('permdock.sync', '', true);
    return null;
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where c.tenant_id is not distinct from v_new_tenant and c.scope = v_new_scope and c.scope_id is not distinct from v_new_id and c.role = v_new_key)
    or exists (select 1 from "permdock".custom_role_includes c where c.tenant_id is not distinct from v_new_tenant and c.scope = v_new_scope and c.scope_id is not distinct from v_new_id and c.role = v_new_key) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || v_new_key || ' already has grants',
      hint = 'role-exists';
  end if;
  update "permdock".custom_role_permissions c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where c.tenant_id is not distinct from v_old_tenant and c.scope = v_old_scope and c.scope_id is not distinct from v_old_id and c.role = v_old_key;
  update "permdock".custom_role_includes c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where c.tenant_id is not distinct from v_old_tenant and c.scope = v_old_scope and c.scope_id is not distinct from v_old_id and c.role = v_old_key;
  if v_checked then
    perform "permdock".permdock_custom_role_guard(v_new_tenant, v_new_scope, v_new_id, v_new_key);
    select array_agg(c.permission) filter (where c.effect = 'allow'),
      array_agg(c.permission) filter (where c.effect = 'deny')
    into v_allow, v_deny
    from "permdock".custom_role_permissions c
    where c.tenant_id is not distinct from v_new_tenant and c.scope = v_new_scope and c.scope_id is not distinct from v_new_id and c.role = v_new_key;
    select array_agg(c.include_role) into v_include
    from "permdock".custom_role_includes c
    where c.tenant_id is not distinct from v_new_tenant and c.scope = v_new_scope and c.scope_id is not distinct from v_new_id and c.role = v_new_key;
    perform "permdock".permdock_custom_role_entries(v_new_scope, v_allow, v_deny, v_include);
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_beyond (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_allow    text[],
  p_deny     text[],
  p_include  text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if false then
    return;
  end if;
  return query
  with resolved as (
    select distinct rp.permission, k.key as grant_key
    from "permdock".permdock_custom_keys(p_allow, p_deny, p_include, p_scope) k(key)
    join "permdock".role_permissions rp on rp.grant_key = k.key and rp.effect = 'allow'
  ),
  held as (
    select distinct rp.permission, rp.grant_key
    from "permdock".role_permissions rp
    where rp.effect = 'allow'
      and rp.permission in (select r.permission from resolved r)
      and ("permdock".permdock_has(rp.grant_key)
        or (p_scope <> 'global'
          and (p_tenant::text in (select x::text from "permdock".permitted_organization_ids(rp.grant_key) x)
            or (case p_scope when 'organization' then false when 'customer' then p_scope_id in (select x::text from "permdock".permitted_customer_ids(rp.grant_key) x) else false end))))
  )
  select distinct r.permission
  from resolved r
  where not exists (select 1 from held h where h.permission = r.permission);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_guard (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_beyond text;
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '' and (
    false
    or (p_scope <> 'global' and coalesce(p_tenant::text in (select x::text from "permdock".member_organization_ids() x)
      or (case p_scope when 'organization' then false when 'customer' then p_scope_id in (select x::text from "permdock".member_customer_ids() x) else false end), false))
  )) then
    raise exception using
      errcode = '42501',
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform'),
      hint = 'not-member';
  end if;
  if p_scope = 'global' then
    if not exists (
    select 1 from "permdock".role_permissions rp
    where rp.effect = 'allow'
      and rp.permission = any(array['roles.manage']::text[])
      and "permdock".permdock_has(rp.grant_key)
  ) then
      raise exception using
        errcode = '42501',
        message = 'permdock: the caller may not manage roles in ' || coalesce(p_tenant::text, 'the platform'),
        hint = 'manage-roles';
    end if;
  elsif not exists (
    select 1 from "permdock".role_permissions rp
    where rp.effect = 'allow'
      and rp.permission = any(array['roles.manage']::text[])
      and p_tenant::text in (select x::text from "permdock".permitted_organization_ids(rp.grant_key) x)
  ) then
    raise exception using
      errcode = '42501',
      message = 'permdock: the caller may not manage roles in ' || coalesce(p_tenant::text, 'the platform'),
      hint = 'manage-roles';
  end if;
  select array_agg(permission) filter (where c.effect = 'allow'),
    array_agg(c.permission) filter (where c.effect = 'deny')
  into v_allow, v_deny
  from "permdock".custom_role_permissions c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else c.tenant_id is not distinct from p_tenant end and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else c.tenant_id is not distinct from p_tenant end and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond(p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      message = 'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out',
      hint = 'not-assignable-by';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_guard_for (
  p_user     uuid,
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_beyond text;
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  if not (coalesce(p_user::text, '') <> '' and (
    false
    or (p_scope <> 'global' and coalesce(p_tenant::text in (select x::text from "permdock".member_organization_ids_for(p_user) x)
      or (case p_scope when 'organization' then false when 'customer' then p_scope_id in (select x::text from "permdock".member_customer_ids_for(p_user) x) else false end), false))
  )) then
    raise exception using
      errcode = '42501',
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform'),
      hint = 'not-member';
  end if;
  if p_scope = 'global' then
    if not exists (
    select 1 from "permdock".role_permissions rp
    where rp.effect = 'allow'
      and rp.permission = any(array['roles.manage']::text[])
      and "permdock".permdock_has_for(p_user, rp.grant_key)
  ) then
      raise exception using
        errcode = '42501',
        message = 'permdock: the caller may not manage roles in ' || coalesce(p_tenant::text, 'the platform'),
        hint = 'manage-roles';
    end if;
  elsif not exists (
    select 1 from "permdock".role_permissions rp
    where rp.effect = 'allow'
      and rp.permission = any(array['roles.manage']::text[])
      and p_tenant::text in (select x::text from "permdock".permitted_organization_ids_for(p_user, rp.grant_key) x)
  ) then
    raise exception using
      errcode = '42501',
      message = 'permdock: the caller may not manage roles in ' || coalesce(p_tenant::text, 'the platform'),
      hint = 'manage-roles';
  end if;
  select array_agg(permission) filter (where c.effect = 'allow'),
    array_agg(c.permission) filter (where c.effect = 'deny')
  into v_allow, v_deny
  from "permdock".custom_role_permissions c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else c.tenant_id is not distinct from p_tenant end and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else c.tenant_id is not distinct from p_tenant end and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond_for(p_user, p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      message = 'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out',
      hint = 'not-assignable-by';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_memo_put (
  p_key   text,
  p_value text
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select set_config(p_key, p_value, true)
$function$;

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
  if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '') or current_setting('permdock.sync', true) = 'on' then
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

CREATE OR REPLACE FUNCTION permdock.permdock_sync_custom_role_permissions()
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
  v_refs text[] := array[
    case when tg_op <> 'INSERT' then old."role_id"::text end,
    case when tg_op <> 'DELETE' then new."role_id"::text end
  ];
begin
  for v in
    select r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'organization' end as scope, null::text as scope_id, r."key"::text as role, r."id" as permissions_ref
    from "public"."roles" r
    where not (r."organization_id"::uuid is not null and coalesce(r."is_system", false)) and not (r."key"::text = any(array['contact', 'guest', 'member', 'owner']::text[])) and r."id"::text = any(v_refs)
  loop
    if v.role is null or not (v.scope = 'global' or v.scope = any(array['organization', 'customer']::text[])) then
      raise warning 'permdock sync: % has scope %, which is not declared', coalesce(v.role, 'null'), coalesce(v.scope, 'null');
      continue;
    end if;
    if v.tenant_id is not null and "permdock".permdock_is_shared_role(v.scope, v.role) then
      raise warning 'permdock sync: % is the name of a shared custom role (name-taken); the legacy write is not copied', v.role;
      continue;
    end if;
    v_dropped := '{}'::text[];
    with raw as (
      select x."permission"::text as legacy, 'allow' as effect, null::text as level
      from "public"."role_permissions" x
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
    v_include := array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is not distinct from v.tenant_id and c.scope = v.scope and c.scope_id is not distinct from v.scope_id and c.role = v.role);
    perform set_config('permdock.sync', 'on', true);
    perform "permdock".permdock_trusted_replace_custom_role_grants(v.tenant_id, v.scope, v.scope_id, v.role, v_allow, v_deny, v_include);
    perform set_config('permdock.sync', '', true);
    if cardinality(v_dropped) > 0 then
      raise warning 'permdock sync: dropped % entr(ies) PermDock cannot hold: %', cardinality(v_dropped), (select string_agg(g.role || ': ' || g.items, '; ' order by g.role)
    from (
      select split_part(l.d, ': ', 1) as role, string_agg(substr(l.d, strpos(l.d, ': ') + 2), ', ' order by l.d) as items
      from (select u.d from unnest(v_dropped) as u(d) order by u.d limit 50) l
      group by 1
    ) g);
    end if;
  end loop;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.subject_for (
  p_user uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := p_user;
  held jsonb;
  memberships jsonb;
  custom jsonb := '[]'::jsonb;
  ver bigint;
  claims jsonb := '{}'::jsonb;
  extra jsonb;
begin
  if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
    return null;
  end if;
  held := "permdock".global_roles_for(uid);
  select coalesce(jsonb_agg(x.entry order by x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text), '[]'::jsonb)
    into memberships
    from "permdock".memberships_for(uid) x;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'name', c.role,
      'shared', case when c.tenant_id is null and c.scope <> 'global' then true end,
      'tenant', c.tenant_id::text,
      'scope', c.scope,
      'id', c.scope_id,
      'grants', (
        select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'permission', p.permission,
            'effect', p.effect,
            'level', to_jsonb(p) ->> 'level'
          )) order by p.permission, p.effect), '[]'::jsonb)
        from "permdock".custom_role_permissions p
        where p.tenant_id is not distinct from c.tenant_id and p.scope = c.scope and p.scope_id is not distinct from c.scope_id and p.role = c.role
      ),
      'includes', (
        select jsonb_agg(p.include_role order by p.include_role)
        from "permdock".custom_role_includes p
        where p.tenant_id is not distinct from c.tenant_id and p.scope = c.scope and p.scope_id is not distinct from c.scope_id and p.role = c.role
      )
    )) order by c.tenant_id::text, c.scope, c.scope_id, c.role), '[]'::jsonb)
    into custom
    from (
      select tenant_id, scope, scope_id, role from "permdock".custom_role_permissions
      union
      select tenant_id, scope, scope_id, role from "permdock".custom_role_includes
    ) c
    where (c.scope = 'global' and c.tenant_id is null and held ? c.role)
      or exists (
        select 1
        from jsonb_array_elements(memberships) m
        where m -> 'roles' ? c.role
          and m ->> 'scope' = c.scope
          and (
            (c.tenant_id is null and c.scope_id is null)
            or c.tenant_id::text = case when m ->> 'scope' = 'organization' then m ->> 'id' else m -> 'within' ->> 'organization' end
          )
          and (c.scope_id is null or c.scope_id = m ->> 'id')
      );
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  ver := coalesce(ver, 0);
  extra := "public"."datetime_preference_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{datetime_preferences}', extra);
  end if;
  extra := "public"."feature_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{features}', extra);
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'claims', case when claims = '{}'::jsonb then null else claims end,
    'id', uid::text,
    'active', true,
    'roles', held,
    'memberships', memberships,
    'customRoles', custom,
    'authzVersion', ver
  ));
end;
$function$;

REVOKE ALL ON FUNCTION "permdock"."memberships_for"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."memberships_for"(uuid) TO "supabase_auth_admin";

REVOKE ALL ON FUNCTION "permdock"."permdock_approver_for_ids"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_approver_for_ids"() TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permdock_memo_put"(text, text) FROM PUBLIC;
