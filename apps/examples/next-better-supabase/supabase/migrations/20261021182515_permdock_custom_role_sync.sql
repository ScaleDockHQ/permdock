SET local check_function_bodies = off;

CREATE TABLE "public"."role_permissions" (
  "role_id"    uuid                     NOT NULL,
  "permission" text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY (role_id, permission)
);

ALTER TABLE "public"."role_permissions"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."role_permissions" FROM "anon";

CREATE OR REPLACE FUNCTION permdock.grant_keys (
  p_permission text,
  p_scope      text,
  p_effect     text DEFAULT 'allow'::text
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select g.grant_key
  from pg_catalog.jsonb_array_elements_text(coalesce(
    '{"customer":{"quotes.list":{"allow":["quotes.list"],"deny":[]},"quotes.read":{"allow":["quotes.read"],"deny":[]}},"organization":{"audit.revert":{"allow":["audit.revert"],"deny":[]},"audit.view":{"allow":["audit.view"],"deny":[]},"quotes.list":{"allow":["quotes.list"],"deny":[]},"quotes.read":{"allow":["quotes.read"],"deny":[]},"quotes.update":{"allow":["quotes.update"],"deny":[]},"roles.manage":{"allow":["roles.manage"],"deny":[]},"staff.list":{"allow":["staff.list"],"deny":[]},"staff.read":{"allow":["staff.read"],"deny":[]}}}'::jsonb -> p_scope -> p_permission -> p_effect,
    '[]'::jsonb
  )) g(grant_key)
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_entries (
  p_scope   text,
  p_allow   text[],
  p_deny    text[],
  p_include text[]
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_entry text;
  v_key text;
  v_problem text;
begin
  foreach v_entry in array coalesce(p_allow, '{}'::text[]) loop
    v_key := v_entry;
    v_problem := "permdock".permdock_custom_role_entry_problem(p_scope, v_entry);
    if v_problem = 'unknown-permission' then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_entry || ' is not a declared permission',
        hint = 'unknown-permission';
    end if;
    if v_problem = 'outside-ceiling' then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_key || ' is outside the ceiling of ' || p_scope,
        hint = 'outside-ceiling';
    end if;
  end loop;
  foreach v_entry in array coalesce(p_deny, '{}'::text[]) loop
    if not (v_entry = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])) then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_entry || ' is not a declared permission',
        hint = 'unknown-permission';
    end if;
  end loop;
  foreach v_entry in array coalesce(p_include, '{}'::text[]) loop
    if not (v_entry = any(array['contact', 'guest', 'member', 'owner']::text[])) then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_entry || ' is not a declared role',
        hint = 'unknown-role';
    end if;
  end loop;
  select string_agg(distinct rp.permission, ', ') into v_key
  from "permdock".role_permissions rp
  where rp.role = any(coalesce(p_include, '{}'::text[]))
    and rp.effect = 'allow'
    and not exists (
      select 1 from "permdock".permdock_ceiling c
      where c.scope = p_scope and c.effect = 'allow' and c.permission = rp.permission
    );
  if v_key is not null then
    raise exception using
      errcode = '22023',
      message = 'permdock: an included role allows ' || v_key || ', outside the ceiling of ' || p_scope,
      hint = 'outside-ceiling';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_entry_problem (
  p_scope text,
  p_entry text
)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_key text := p_entry;
begin
  if p_entry is null or not (v_key = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])) then
    return 'unknown-permission';
  end if;
  if not exists (
    select 1 from "permdock".permdock_ceiling c
    where c.scope = p_scope and c.effect = 'allow' and c.permission = v_key
  ) then
    return 'outside-ceiling';
  end if;
  return null;
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
  if not exists (
    select 1 from "permdock".role_permissions rp
    where rp.effect = 'allow'
      and rp.permission = any(array['roles.manage']::text[])
      and ("permdock".permdock_has(rp.grant_key)
        or (p_scope <> 'global'
          and (p_tenant::text in (select x::text from "permdock".permitted_organization_ids(rp.grant_key) x)
            or (case p_scope when 'organization' then false when 'customer' then p_scope_id in (select x::text from "permdock".permitted_customer_ids(rp.grant_key) x) else false end))))
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
  if not exists (
    select 1 from "permdock".role_permissions rp
    where rp.effect = 'allow'
      and rp.permission = any(array['roles.manage']::text[])
      and ("permdock".permdock_has_for(p_user, rp.grant_key)
        or (p_scope <> 'global'
          and (p_tenant::text in (select x::text from "permdock".permitted_organization_ids_for(p_user, rp.grant_key) x)
            or (case p_scope when 'organization' then false when 'customer' then p_scope_id in (select x::text from "permdock".permitted_customer_ids_for(p_user, rp.grant_key) x) else false end))))
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

CREATE OR REPLACE FUNCTION permdock.permdock_permission_keys()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select k.permission from unnest(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[]) k(permission) order by 1
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_permission_keys (
  p_scope text
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select distinct rp.permission
  from "permdock".role_permissions rp
  where rp.scope = p_scope
    and rp.effect = 'allow'
    and rp.permission = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])
  order by 1
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
          when m.key is null or not (m.key = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])) then 'not a declared permission'
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
          when m.key is null or not (m.key = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])) then 'not a declared permission'
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
    perform "permdock".permdock_trusted_replace_custom_role_grants(v.tenant_id, v.scope, v.scope_id, v.role, v_allow, v_deny, v_include);
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

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_role_permissions_by_id (
  p_role_ids text[],
  p_tenant   uuid   DEFAULT NULL::uuid
)
  RETURNS TABLE (
    role_id    text,
    permission text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if p_tenant is not null and exists (
    select 1 from "public"."roles" r
    where r."id"::text = any(p_role_ids) and r."organization_id"::uuid is distinct from p_tenant
  ) then
    raise exception using
      errcode = '42501',
      message = 'permdock: a role id belongs to another tenant than ' || p_tenant::text,
      hint = 'not-member';
  end if;
  return query
  select distinct v.role_id, c.permission
  from (
    select r."id"::text as role_id, r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'organization' end as scope, null::text as scope_id, r."key"::text as role
    from "public"."roles" r
    where r."id"::text = any(p_role_ids)
      and not (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
      and not (r."key"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ) v
  join "permdock".custom_role_permissions c
    on c.tenant_id is not distinct from v.tenant_id
    and c.scope = v.scope
    and c.scope_id is not distinct from v.scope_id
    and c.role = v.role
  where c.effect = 'allow'
    and c.permission = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])
  order by 1, 2;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('roles.manage', 'organization', 'allow', 'roles.manage'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = (select "permdock".permdock_user_id())
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('roles.manage', 'organization', 'allow', 'roles.manage'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = (select "permdock".permdock_user_id())
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('roles.manage', 'organization', 'allow', 'roles.manage'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = p_user
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('roles.manage', 'organization', 'allow', 'roles.manage'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = p_user
    and rp.scope = 'global'
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

ALTER TABLE "public"."role_permissions"
  ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.role_permissions
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore": [], "redact": [], "key_columns": ["role_id", "permission"]}');

CREATE TRIGGER permdock_sync_custom_role_guard_permissions
  BEFORE INSERT OR DELETE OR UPDATE ON public.role_permissions
  FOR EACH ROW
  EXECUTE FUNCTION permdock.permdock_sync_custom_role_guard_permissions();

CREATE TRIGGER permdock_sync_custom_role_permissions
  AFTER INSERT OR DELETE OR UPDATE ON public.role_permissions
  FOR EACH ROW
  EXECUTE FUNCTION permdock.permdock_sync_custom_role_permissions();

CREATE POLICY "role_permissions_manage" ON "public"."role_permissions"
  FOR ALL
  TO "authenticated"
  USING ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE
    ((r.id = role_permissions.role_id) AND (r.organization_id IN ( SELECT permdock.permitted_organization_ids_by_permission('roles.manage'::text) AS
    permitted_organization_ids_by_permission))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE
    ((r.id = role_permissions.role_id) AND (r.organization_id IN ( SELECT permdock.permitted_organization_ids_by_permission('roles.manage'::text) AS
    permitted_organization_ids_by_permission))))));

CREATE POLICY "roles_read_members" ON "public"."roles"
  FOR SELECT
  TO "authenticated"
  USING ((organization_id IN ( SELECT permdock.member_organization_ids() AS member_organization_ids)));

REVOKE ALL ON FUNCTION "permdock"."permdock_sync_custom_role_guard_permissions"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_sync_custom_role_permissions"() FROM PUBLIC;

REVOKE ALL ON TABLE "public"."role_permissions" FROM "authenticated";

GRANT DELETE, INSERT, SELECT ON TABLE "public"."role_permissions" TO "authenticated";

REVOKE ALL ON TABLE "public"."role_permissions" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."role_permissions" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."role_permissions" TO "service_role";

REVOKE ALL ON TABLE "public"."roles" FROM "authenticated";

GRANT SELECT ON TABLE "public"."roles" TO "authenticated";
