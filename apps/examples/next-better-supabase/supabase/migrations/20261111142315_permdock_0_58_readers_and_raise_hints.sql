SET local check_function_bodies = off;

REVOKE ALL ON TABLE "permdock"."user_roles" FROM "supabase_auth_admin";

REVOKE ALL ON TABLE "public"."contacts" FROM "supabase_auth_admin";

REVOKE ALL ON TABLE "public"."organization_memberships" FROM "supabase_auth_admin";

DROP POLICY "permdock_auth_admin_read_roles" ON "permdock"."user_roles";

DROP POLICY "permdock_auth_admin_read_memberships" ON "public"."contacts";

DROP POLICY "permdock_auth_admin_read_memberships" ON "public"."organization_memberships";

CREATE OR REPLACE FUNCTION permdock.global_roles_for (
  p_user uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_roles_user "permdock"."user_roles"."user_id"%type := p_user;
  held jsonb;
begin
  select coalesce(jsonb_agg(distinct r."role"::text order by r."role"::text) filter (where r."role"::text is not null), '[]'::jsonb)
    into held
    from "permdock"."user_roles" r
    where r."user_id" = v_roles_user;
  return held;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_bootstrap_permissions (
  p_tenant text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  with pdk_k(key, n) as (
    select k.key, (k.n - 1)::integer
    from unnest(array['audit.read', 'audit.revert', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[]) with ordinality as k(key, n)
  ),
  pdk_t(id) as (
    select t.id from "permdock".member_organization_ids() as t(id)
    where p_tenant is null or t.id::text = p_tenant
  ),
  pdk_p(n) as (
    select k.n from pdk_k k
    where k.key = any(array[]::text[]) and "permdock".permdock_has_permission(k.key)
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'apiVersion', 1,
    'form', 'compact',
    'keys', to_jsonb(array['audit.read', 'audit.revert', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[]),
    'tenants', coalesce((
      select jsonb_object_agg(t.id::text, (select translate(encode(coalesce(decode(string_agg(lpad(to_hex(coalesce(b.v, 0)), 2, '0'), '' order by g.i), 'hex'), ''::bytea), 'base64'), '+/=' || chr(10), '-_')
      from generate_series(0, 0) g(i)
      left join (
        select x.n / 8 as i, sum(1 << (x.n % 8)) as v from (select k.n from "permdock".permitted_organization_permission_keys(t.id) h(key) join pdk_k k on k.key = h.key) x(n) group by 1
      ) b on b.i = g.i))
      from pdk_t t
    ), '{}'::jsonb),
    'platform', case when exists (select 1 from pdk_p) then (select translate(encode(coalesce(decode(string_agg(lpad(to_hex(coalesce(b.v, 0)), 2, '0'), '' order by g.i), 'hex'), ''::bytea), 'base64'), '+/=' || chr(10), '-_')
      from generate_series(0, 0) g(i)
      left join (
        select x.n / 8 as i, sum(1 << (x.n % 8)) as v from (select p.n from pdk_p p) x(n) group by 1
      ) b on b.i = g.i) end
  ))
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
  if not exists (select 1 from "permdock".custom_role_permissions c where (v_old_tenant is null and c.tenant_id is null or c.tenant_id = v_old_tenant) and c.scope = v_old_scope and (v_old_id is null and c.scope_id is null or c.scope_id = v_old_id) and c.role = v_old_key)
    and not exists (select 1 from "permdock".custom_role_includes c where (v_old_tenant is null and c.tenant_id is null or c.tenant_id = v_old_tenant) and c.scope = v_old_scope and (v_old_id is null and c.scope_id is null or c.scope_id = v_old_id) and c.role = v_old_key) then
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
  if exists (select 1 from "permdock".custom_role_permissions c where (v_new_tenant is null and c.tenant_id is null or c.tenant_id = v_new_tenant) and c.scope = v_new_scope and (v_new_id is null and c.scope_id is null or c.scope_id = v_new_id) and c.role = v_new_key)
    or exists (select 1 from "permdock".custom_role_includes c where (v_new_tenant is null and c.tenant_id is null or c.tenant_id = v_new_tenant) and c.scope = v_new_scope and (v_new_id is null and c.scope_id is null or c.scope_id = v_new_id) and c.role = v_new_key) then
    raise exception using
      errcode = '22023',
      hint = 'role-exists',
      message = 'permdock: ' || v_new_key || ' already has grants';
  end if;
  update "permdock".custom_role_permissions c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where (v_old_tenant is null and c.tenant_id is null or c.tenant_id = v_old_tenant) and c.scope = v_old_scope and (v_old_id is null and c.scope_id is null or c.scope_id = v_old_id) and c.role = v_old_key;
  update "permdock".custom_role_includes c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where (v_old_tenant is null and c.tenant_id is null or c.tenant_id = v_old_tenant) and c.scope = v_old_scope and (v_old_id is null and c.scope_id is null or c.scope_id = v_old_id) and c.role = v_old_key;
  if v_checked then
    perform "permdock".permdock_custom_role_guard(v_new_tenant, v_new_scope, v_new_id, v_new_key);
    select array_agg(c.permission) filter (where c.effect = 'allow'),
      array_agg(c.permission) filter (where c.effect = 'deny')
    into v_allow, v_deny
    from "permdock".custom_role_permissions c
    where (v_new_tenant is null and c.tenant_id is null or c.tenant_id = v_new_tenant) and c.scope = v_new_scope and (v_new_id is null and c.scope_id is null or c.scope_id = v_new_id) and c.role = v_new_key;
    select array_agg(c.include_role) into v_include
    from "permdock".custom_role_includes c
    where (v_new_tenant is null and c.tenant_id is null or c.tenant_id = v_new_tenant) and c.scope = v_new_scope and (v_new_id is null and c.scope_id is null or c.scope_id = v_new_id) and c.role = v_new_key;
    perform "permdock".permdock_custom_role_entries(v_new_scope, v_allow, v_deny, v_include);
  end if;
  return null;
end;
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
        hint = 'unknown-permission',
        message = 'permdock: ' || v_entry || ' is not a declared permission';
    end if;
    if v_problem = 'outside-ceiling' then
      raise exception using
        errcode = '22023',
        hint = 'outside-ceiling',
        message = 'permdock: ' || v_key || ' is outside the ceiling of ' || p_scope;
    end if;
  end loop;
  foreach v_entry in array coalesce(p_deny, '{}'::text[]) loop
    if not (v_entry = any(array['audit.read', 'audit.revert', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])) then
      raise exception using
        errcode = '22023',
        hint = 'unknown-permission',
        message = 'permdock: ' || v_entry || ' is not a declared permission';
    end if;
  end loop;
  foreach v_entry in array coalesce(p_include, '{}'::text[]) loop
    if not (v_entry = any(array['contact', 'guest', 'member', 'owner']::text[])) then
      raise exception using
        errcode = '22023',
        hint = 'unknown-role',
        message = 'permdock: ' || v_entry || ' is not a declared role';
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
      hint = 'outside-ceiling',
      message = 'permdock: an included role allows ' || v_key || ', outside the ceiling of ' || p_scope;
  end if;
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
      hint = 'not-member',
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform');
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
      hint = 'manage-roles',
      message = 'permdock: the caller may not manage roles in ' || coalesce(p_tenant::text, 'the platform');
  end if;
  select array_agg(permission) filter (where c.effect = 'allow'),
    array_agg(c.permission) filter (where c.effect = 'deny')
  into v_allow, v_deny
  from "permdock".custom_role_permissions c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond(p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      hint = 'not-assignable-by',
      message = 'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out';
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
      hint = 'not-member',
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform');
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
      hint = 'manage-roles',
      message = 'permdock: the caller may not manage roles in ' || coalesce(p_tenant::text, 'the platform');
  end if;
  select array_agg(permission) filter (where c.effect = 'allow'),
    array_agg(c.permission) filter (where c.effect = 'deny')
  into v_allow, v_deny
  from "permdock".custom_role_permissions c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond_for(p_user, p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      hint = 'not-assignable-by',
      message = 'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_name_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if new."organization_id"::uuid is null or coalesce(new."is_system", false) then
    return new;
  end if;
  if new."key"::text = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || new."key"::text || ' is a declared role';
  end if;
  if "permdock".permdock_is_shared_role(case when new."organization_id"::uuid is null then 'global' else 'organization' end, new."key"::text) then
    raise exception using
      errcode = '22023',
      hint = 'name-taken',
      message = 'permdock: ' || new."key"::text || ' is a shared role';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_shape (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  if p_scope = 'global' then
    if p_tenant is not null or p_scope_id is not null then
      raise exception using
        errcode = '22023',
        hint = 'unknown-scope',
        message = 'permdock: a platform custom role has no tenant or instance';
    end if;
  elsif not (p_scope = any(array['organization', 'customer']::text[])) then
    raise exception using
      errcode = '22023',
      hint = 'unknown-scope',
      message = 'permdock: custom roles are held at a scope of a tenant or at global, not ' || coalesce(p_scope, 'null');
  elsif p_tenant is null and p_scope_id is not null then
    raise exception using
      errcode = '22023',
      hint = 'unknown-scope',
      message = 'permdock: a shared custom role has no instance';
  end if;
  if coalesce(p_role, '') = '' or p_role = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(p_role, 'null') || ' is not a custom role name';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_holders_organization()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_ids text[] := '{}';
  v_id text;
  v_key_0 "public"."organization_memberships"."organization_id"%type;
  v_total bigint;
  v_count bigint;
begin
  if tg_relid = '"public"."organization_memberships"'::regclass then
    if tg_op in ('UPDATE', 'DELETE') then
      v_ids := v_ids || old."organization_id"::text;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      v_ids := v_ids || new."organization_id"::text;
    end if;
  end if;
  foreach v_id in array v_ids loop
    continue when v_id is null;
    v_key_0 := v_id;
    select count(*) into v_total
      from (
        select m."organization_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."organization_memberships" m
        where m."organization_id" = v_key_0
      ) h;
    select count(distinct h.user_id) into v_count
      from (
        select m."organization_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."organization_memberships" m
        where m."organization_id" = v_key_0
      ) h
      where h.live
        and h.role = 'owner';
    if v_total > 0 and v_count < 1 then
      raise exception using
        errcode = '23514',
        hint = 'last-holder',
        message = 'permdock: organization ' || v_id || ' keeps at least 1 owner';
    end if;
  end loop;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_rename_custom_role_grants (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_from     text,
  p_to       text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform "permdock".permdock_custom_role_guard(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      hint = 'name-taken',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to) then
    raise exception using
      errcode = '22023',
      hint = 'role-exists',
      message = 'permdock: ' || p_to || ' already has grants';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_replace_custom_role_grants (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text,
  p_allow    text[],
  p_deny     text[],
  p_include  text[]
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_beyond text;
begin
  perform "permdock".permdock_custom_role_guard(p_tenant, p_scope, p_scope_id, p_role);
  perform "permdock".permdock_custom_role_entries(p_scope, p_allow, p_deny, p_include);
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond(p_tenant, p_scope, p_scope_id, p_allow, p_deny, p_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      hint = 'not-assignable-by',
      message = 'permdock: ' || p_role || ' would allow ' || v_beyond || ', which the caller may not hand out';
  end if;
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_role) then
    raise exception using
      errcode = '22023',
      hint = 'name-taken',
      message = 'permdock: ' || p_role || ' is the name of a shared custom role';
  end if;
  delete from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  delete from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  insert into "permdock".custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect)
  select distinct p_tenant, p_scope, p_scope_id, p_role, e, 'allow'
  from unnest(coalesce(p_allow, '{}'::text[])) e
  union
  select distinct p_tenant, p_scope, p_scope_id, p_role, e, 'deny'
  from unnest(coalesce(p_deny, '{}'::text[])) e;
  insert into "permdock".custom_role_includes (tenant_id, scope, scope_id, role, include_role)
  select distinct p_tenant, p_scope, p_scope_id, p_role, e
  from unnest(coalesce(p_include, '{}'::text[])) e;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_replace_custom_role_grants_by_id (
  p_role_id     uuid,
  p_permissions text[]
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
  v_scope text;
  v_scope_id text;
  v_key text;
  v_skipped boolean;
  v_deny text[];
  v_include text[];
begin
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'organization' end, null::text, r."key"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      hint = 'unknown-role',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null');
  end if;
  if v_skipped or v_key = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where (v_tenant is null and c.tenant_id is null or c.tenant_id = v_tenant) and c.scope = v_scope and (v_scope_id is null and c.scope_id is null or c.scope_id = v_scope_id) and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where (v_tenant is null and c.tenant_id is null or c.tenant_id = v_tenant) and c.scope = v_scope and (v_scope_id is null and c.scope_id is null or c.scope_id = v_scope_id) and c.role = v_key;
  perform "permdock".permdock_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "source" => 'permdock');
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_role_permissions (
  p_role     text,
  p_scope    text,
  p_tenant   uuid DEFAULT NULL::uuid,
  p_scope_id text DEFAULT NULL::text
)
  RETURNS TABLE (
    permission text,
    effect     text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if p_role = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    return query
  select distinct rp.permission, rp.effect
  from "permdock".role_permissions rp
  where rp.role = p_role and rp.scope = p_scope
  order by 1, 2;
    return;
  end if;
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '' and (
    false
    or (p_scope <> 'global' and p_tenant is null and p_scope_id is null)
    or (p_scope <> 'global' and (p_tenant::text in (select x::text from "permdock".member_organization_ids() x)
      or (case p_scope when 'organization' then false when 'customer' then p_scope_id in (select x::text from "permdock".member_customer_ids() x) else false end)))
  )) then
    raise exception using
      errcode = '42501',
      hint = 'not-member',
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform');
  end if;
  return query
  select distinct rp.permission, rp.effect
  from "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role),
    p_scope
  ) k(grant_key)
  join "permdock".role_permissions rp on rp.grant_key = k.grant_key and rp.scope = p_scope
  order by 1, 2;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_subject (
  p_tenant text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
  subject jsonb;
begin
  if p_tenant is null then
    return null;
  end if;
  begin
    v_tenant := p_tenant::uuid;
  exception when invalid_text_representation then
    return null;
  end;
  subject := "permdock".subject_for((select "permdock".permdock_user_id()), v_tenant);
  if subject is null
    or (subject ->> 'active') is distinct from 'true'
    or coalesce(jsonb_array_length(subject -> 'memberships'), 0) = 0 then
    return null;
  end if;
  return subject || jsonb_build_object('tenant', v_tenant::text);
end;
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
        hint = case
          when v_dropped[1] like '%outside the ceiling of %' then 'outside-ceiling'
          when v_dropped[1] like '%, level % is not declared' then 'unknown-level'
          when v_dropped[1] like '%, not a declared role' then 'unknown-role'
          else 'unknown-permission'
        end,
        message = 'permdock: ' || v_dropped[1];
    end if;
    select string_agg(b, ', ' order by b) into v_beyond
    from "permdock".permdock_custom_role_beyond(v.tenant_id, v.scope, v.scope_id, v_allow, v_deny, v_include) b;
    if v_beyond is not null then
      raise exception using
        errcode = '42501',
        hint = 'not-assignable-by',
        message = 'permdock: ' || v.role || ' would allow ' || v_beyond || ', which the caller may not hand out';
    end if;
  end loop;
  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_rename_custom_role_grants (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_from     text,
  p_to       text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      hint = 'name-taken',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to) then
    raise exception using
      errcode = '22023',
      hint = 'role-exists',
      message = 'permdock: ' || p_to || ' already has grants';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_replace_custom_role_grants (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text,
  p_allow    text[],
  p_deny     text[],
  p_include  text[]
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  perform "permdock".permdock_custom_role_entries(p_scope, p_allow, p_deny, p_include);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_role) then
    raise exception using
      errcode = '22023',
      hint = 'name-taken',
      message = 'permdock: ' || p_role || ' is the name of a shared custom role';
  end if;
  delete from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  delete from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  insert into "permdock".custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect)
  select distinct p_tenant, p_scope, p_scope_id, p_role, e, 'allow'
  from unnest(coalesce(p_allow, '{}'::text[])) e
  union
  select distinct p_tenant, p_scope, p_scope_id, p_role, e, 'deny'
  from unnest(coalesce(p_deny, '{}'::text[])) e;
  insert into "permdock".custom_role_includes (tenant_id, scope, scope_id, role, include_role)
  select distinct p_tenant, p_scope, p_scope_id, p_role, e
  from unnest(coalesce(p_include, '{}'::text[])) e;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_replace_custom_role_grants_by_id (
  p_role_id     uuid,
  p_permissions text[]
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
  v_scope text;
  v_scope_id text;
  v_key text;
  v_skipped boolean;
  v_deny text[];
  v_include text[];
begin
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'organization' end, null::text, r."key"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      hint = 'unknown-role',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null');
  end if;
  if v_skipped or v_key = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where (v_tenant is null and c.tenant_id is null or c.tenant_id = v_tenant) and c.scope = v_scope and (v_scope_id is null and c.scope_id is null or c.scope_id = v_scope_id) and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where (v_tenant is null and c.tenant_id is null or c.tenant_id = v_tenant) and c.scope = v_scope and (v_scope_id is null and c.scope_id is null or c.scope_id = v_scope_id) and c.role = v_key;
  perform "permdock".permdock_trusted_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "source" => 'permdock');
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
      hint = 'not-member',
      message = 'permdock: a role id belongs to another tenant than ' || p_tenant::text;
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
    on (v.tenant_id is null and c.tenant_id is null or c.tenant_id = v.tenant_id)
    and c.scope = v.scope
    and (v.scope_id is null and c.scope_id is null or c.scope_id = v.scope_id)
    and c.role = v.role
  where c.effect = 'allow'
    and c.permission = any(array['audit.read', 'audit.revert', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])
  order by 1, 2;
end;
$function$;

REVOKE ALL ON FUNCTION "permdock"."permdock_bootstrap_permissions"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_bootstrap_permissions"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permdock_subject"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_subject"(text) TO "authenticated";
