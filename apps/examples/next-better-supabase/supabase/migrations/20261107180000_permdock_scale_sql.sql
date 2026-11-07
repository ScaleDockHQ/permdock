-- permdock scale pass: tenant-led predicates, the custom-role probe, set helpers, planner hints
create or replace function "permdock".permdock_user_id()
returns uuid
language sql
stable
parallel safe
set search_path = ''
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid
$$;
create index if not exists "custom_role_permissions_probe_idx"
  on "permdock".custom_role_permissions (tenant_id, scope, role) include (scope_id, permission, effect);
create index if not exists "custom_role_includes_probe_idx"
  on "permdock".custom_role_includes (tenant_id, scope, role) include (scope_id, include_role);
create or replace function "permdock".permitted_organization_ids(p_grant text)
returns setof uuid
language plpgsql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.allow, pdk_e.deny, pdk_e.incl
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.id)::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  ),
  pdk_k as materialized (
    select a.allow, a.deny, a.incl
    from (select distinct pdk_m.allow, pdk_m.deny, pdk_m.incl from pdk_m) a
    cross join lateral "permdock".permdock_custom_keys(a.allow, a.deny, a.incl, 'organization') k(grant_key)
    where k.grant_key = p_grant
  )
  select (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select pdk_m.id from pdk_m
  join pdk_k on pdk_k.allow = pdk_m.allow and pdk_k.deny = pdk_m.deny and pdk_k.incl = pdk_m.incl;
end;
$$;
create or replace function "permdock".permitted_organization_id_array(p_grant text)
returns uuid[]
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
  select coalesce(array_agg(i), '{}'::uuid[]) from "permdock".permitted_organization_ids(p_grant) i
$$;
revoke execute on function "permdock".permitted_organization_id_array(text) from public, anon;
grant execute on function "permdock".permitted_organization_id_array(text) to authenticated;
create or replace function "permdock".permdock_organization_has(p_grant text, p_tenant uuid)
returns boolean
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
  select p_tenant = any("permdock".permitted_organization_id_array(p_grant))
$$;
revoke execute on function "permdock".permdock_organization_has(text, uuid) from public, anon;
grant execute on function "permdock".permdock_organization_has(text, uuid) to authenticated;
create or replace function "permdock".member_organization_ids()
returns setof uuid
language plpgsql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$$;
create or replace function "permdock".permitted_customer_ids(p_grant text)
returns setof uuid
language plpgsql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.allow, pdk_e.deny, pdk_e.incl
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  ),
  pdk_k as materialized (
    select a.allow, a.deny, a.incl
    from (select distinct pdk_m.allow, pdk_m.deny, pdk_m.incl from pdk_m) a
    cross join lateral "permdock".permdock_custom_keys(a.allow, a.deny, a.incl, 'customer') k(grant_key)
    where k.grant_key = p_grant
  )
  select (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select pdk_m.id from pdk_m
  join pdk_k on pdk_k.allow = pdk_m.allow and pdk_k.deny = pdk_m.deny and pdk_k.incl = pdk_m.incl;
end;
$$;
create or replace function "permdock".permitted_customer_id_array(p_grant text)
returns uuid[]
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
  select coalesce(array_agg(i), '{}'::uuid[]) from "permdock".permitted_customer_ids(p_grant) i
$$;
revoke execute on function "permdock".permitted_customer_id_array(text) from public, anon;
grant execute on function "permdock".permitted_customer_id_array(text) to authenticated;
create or replace function "permdock".member_customer_ids()
returns setof uuid
language plpgsql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$$;
create or replace function "permdock".permitted_organization_ids_for(p_user uuid, p_grant text)
returns setof uuid
language plpgsql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.allow, pdk_e.deny, pdk_e.incl
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.id)::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_k as materialized (
    select a.allow, a.deny, a.incl
    from (select distinct pdk_m.allow, pdk_m.deny, pdk_m.incl from pdk_m) a
    cross join lateral "permdock".permdock_custom_keys(a.allow, a.deny, a.incl, 'organization') k(grant_key)
    where k.grant_key = p_grant
  )
  select (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
  union
  select pdk_m.id from pdk_m
  join pdk_k on pdk_k.allow = pdk_m.allow and pdk_k.deny = pdk_m.deny and pdk_k.incl = pdk_m.incl;
end;
$$;
create or replace function "permdock".permitted_customer_ids_for(p_user uuid, p_grant text)
returns setof uuid
language plpgsql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
declare
  v_user_0 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.allow, pdk_e.deny, pdk_e.incl
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_k as materialized (
    select a.allow, a.deny, a.incl
    from (select distinct pdk_m.allow, pdk_m.deny, pdk_m.incl from pdk_m) a
    cross join lateral "permdock".permdock_custom_keys(a.allow, a.deny, a.incl, 'customer') k(grant_key)
    where k.grant_key = p_grant
  )
  select (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and rp.scope = 'customer'
  union
  select pdk_m.id from pdk_m
  join pdk_k on pdk_k.allow = pdk_m.allow and pdk_k.deny = pdk_m.deny and pdk_k.incl = pdk_m.incl;
end;
$$;
create or replace function "permdock".permitted_organization_permission_keys(p_id uuid)
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.read', 'organization', 'allow', 'audit.read'),
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
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
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select false as shared) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where i.tenant_id is null and i.scope = 'global' and i.scope_id is null and i.role = ur.role::text order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.id)::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'organization') k(grant_key)) ck(grant_key)
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
$$;
create or replace function "permdock".permitted_organization_permission_keys(p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.read', 'organization', 'allow', 'audit.read'),
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
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
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select false as shared) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where i.tenant_id is null and i.scope = 'global' and i.scope_id is null and i.role = ur.role::text order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.id)::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'organization') k(grant_key)) ck(grant_key)
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
$$;
create or replace function "permdock".permitted_customer_permission_keys(p_id uuid)
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
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
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select false as shared) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where i.tenant_id is null and i.scope = 'global' and i.scope_id is null and i.role = ur.role::text order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'customer') k(grant_key)) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
create or replace function "permdock".permitted_customer_permission_keys(p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
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
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select false as shared) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where i.tenant_id is null and i.scope = 'global' and i.scope_id is null and i.role = ur.role::text order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'customer') k(grant_key)) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
create or replace function "permdock".permitted_organization_permission_keys_for(p_user uuid, p_id uuid)
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.read', 'organization', 'allow', 'audit.read'),
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
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
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select false as shared) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where i.tenant_id is null and i.scope = 'global' and i.scope_id is null and i.role = ur.role::text order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.id)::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'organization') k(grant_key)) ck(grant_key)
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
$$;
create or replace function "permdock".permitted_organization_permission_keys_for(p_user uuid, p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.read', 'organization', 'allow', 'audit.read'),
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
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
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select false as shared) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where i.tenant_id is null and i.scope = 'global' and i.scope_id is null and i.role = ur.role::text order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
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
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.id)::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'organization') k(grant_key)) ck(grant_key)
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
$$;
create or replace function "permdock".permitted_customer_permission_keys_for(p_user uuid, p_id uuid)
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
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
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select false as shared) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where i.tenant_id is null and i.scope = 'global' and i.scope_id is null and i.role = ur.role::text order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'customer') k(grant_key)) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
create or replace function "permdock".permitted_customer_permission_keys_for(p_user uuid, p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
declare
  v_user_0 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
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
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select false as shared) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where i.tenant_id is null and i.scope = 'global' and i.scope_id is null and i.role = ur.role::text order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select p.allow, p.deny, i.incl
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select array(select i.include_role from "permdock".custom_role_includes i where (not pdk_s.shared and i.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and i.tenant_id is null) and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
        ) p) pdk_e
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'customer') k(grant_key)) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;
create index if not exists "approval_delegations_delegator" on "permdock".approval_delegations (delegator, "until");
drop policy if exists "approval_delegations_read" on "permdock".approval_delegations;
create policy "approval_delegations_read" on "permdock".approval_delegations
  for select to authenticated
  using (delegator = (select "permdock".permdock_user_id())::uuid or delegate = (select "permdock".permdock_user_id())::uuid);
drop policy if exists "approval_delegations_insert" on "permdock".approval_delegations;
create policy "approval_delegations_insert" on "permdock".approval_delegations
  for insert to authenticated
  with check (delegator = (select "permdock".permdock_user_id())::uuid and (select "permdock".permdock_actor_may_write()) and (tenant is null or tenant in (select m.id::text from "permdock".member_organization_ids() m(id))));
drop policy if exists "approval_delegations_update" on "permdock".approval_delegations;
create policy "approval_delegations_update" on "permdock".approval_delegations
  for update to authenticated
  using (delegator = (select "permdock".permdock_user_id())::uuid and (select "permdock".permdock_actor_may_write()))
  with check (delegator = (select "permdock".permdock_user_id())::uuid and (select "permdock".permdock_actor_may_write()) and (tenant is null or tenant in (select m.id::text from "permdock".member_organization_ids() m(id))));
drop policy if exists "approval_delegations_delete" on "permdock".approval_delegations;
create policy "approval_delegations_delete" on "permdock".approval_delegations
  for delete to authenticated
  using (delegator = (select "permdock".permdock_user_id())::uuid and (select "permdock".permdock_actor_may_write()));
create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text, p_requester text, p_resource text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    where d.delegate = v_user::uuid
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
$$;
create or replace function "permdock".permdock_approver_for_ids()
returns setof uuid
language sql
stable
security definer
cost 100
rows 5
parallel safe
set search_path = ''
as $$
  select (select "permdock".permdock_user_id())
  where (select "permdock".permdock_user_id()) is not null
  union
  select d.delegator
  from "permdock".approval_delegations d
  where d.delegate = (select "permdock".permdock_user_id())
    and d."from" <= now()
    and d."until" > now()
    and d.delegator <> (select "permdock".permdock_user_id())
$$;
create or replace function "permdock".permitted_quotes_match(p_row "public"."quotes", p_permission text)
returns boolean
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
  with permdock_candidates as (select (p_row).*)
  select exists (select 1 from permdock_candidates where case p_permission
    when 'quotes.list' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list'))))), false)
    when 'quotes.read' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read'))))), false)
    when 'quotes.update' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update')))), false)
    else false
  end)
$$;
create or replace function "permdock".permitted_quotes_rows(p_permission text)
returns setof uuid
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
  select "id"::uuid from "public"."quotes" as permdock_row
  where case p_permission
    when 'quotes.list' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list'))))), false)
    when 'quotes.read' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read'))))), false)
    when 'quotes.update' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update')))), false)
    else "permdock".permitted_quotes_match(permdock_row, p_permission)
  end
$$;
create or replace function "permdock".permitted_quotes_ids_in(p_permission text, p_ids uuid[])
returns setof uuid
language sql
stable
security definer
cost 1000
set search_path = ''
as $$
  select i from "permdock".permitted_quotes_rows(p_permission, p_ids) i
$$;
revoke execute on function "permdock".permitted_quotes_ids_in(text, uuid[]) from public, anon;
grant execute on function "permdock".permitted_quotes_ids_in(text, uuid[]) to authenticated;
create or replace function "permdock".permitted_quotes_rows(p_permission text, p_tenant uuid)
returns setof uuid
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
  select "id"::uuid from "public"."quotes" as permdock_row
  where permdock_row."organization_id" = p_tenant
    and case p_permission
    when 'quotes.list' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list'))))), false)
    when 'quotes.read' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read'))))), false)
    when 'quotes.update' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update')))), false)
    else "permdock".permitted_quotes_match(permdock_row, p_permission)
  end
$$;
revoke execute on function "permdock".permitted_quotes_rows(text, uuid) from public, anon;
grant execute on function "permdock".permitted_quotes_rows(text, uuid) to authenticated;
create or replace function "permdock".permitted_quotes_count(p_permission text, p_tenant uuid, p_cap integer)
returns integer
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
  select count(*)::integer from (select 1 from "permdock".permitted_quotes_rows(p_permission, p_tenant) limit greatest(p_cap, 0)) s
$$;
revoke execute on function "permdock".permitted_quotes_count(text, uuid, integer) from public, anon;
grant execute on function "permdock".permitted_quotes_count(text, uuid, integer) to authenticated;
drop policy if exists "staff_select" on "public"."staff";
create policy "staff_select"
  on "public"."staff"
  as permissive
  for select
  to authenticated
  using (("organization_id" = any(array(select "permdock".permitted_organization_ids('staff.read')))) or ("organization_id" = any(array(select "permdock".permitted_organization_ids('staff.list')))));
drop policy if exists "quotes_select" on "public"."quotes";
create policy "quotes_select"
  on "public"."quotes"
  as permissive
  for select
  to authenticated
  using ((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read'))))) or (("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list'))))));
drop policy if exists "quotes_update" on "public"."quotes";
create policy "quotes_update"
  on "public"."quotes"
  as permissive
  for update
  to authenticated
  using ("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update'))))
  with check ("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update'))));
create or replace function "permdock".subject_for(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
      select p.tenant_id, p.scope, p.scope_id, p.role
      from (
        select m ->> 'scope' as scope, m ->> 'id' as id,
          case when m ->> 'scope' = 'organization' then m ->> 'id' else m -> 'within' ->> 'organization' end as tenant,
          r.role
        from jsonb_array_elements(memberships) m
        cross join lateral jsonb_array_elements_text(case when jsonb_typeof(m -> 'roles') = 'array' then m -> 'roles' else '[]'::jsonb end) r(role)
      ) h
      cross join lateral (
        select t.tenant_id, t.scope, t.scope_id, t.role from "permdock".custom_role_permissions t
        where t.scope = h.scope and t.role = h.role
          and (t.tenant_id is null and t.scope_id is null or t.tenant_id = h.tenant::uuid)
          and (t.scope_id is null or t.scope_id = h.id)
        union
        select t.tenant_id, t.scope, t.scope_id, t.role from "permdock".custom_role_includes t
        where t.scope = h.scope and t.role = h.role
          and (t.tenant_id is null and t.scope_id is null or t.tenant_id = h.tenant::uuid)
          and (t.scope_id is null or t.scope_id = h.id)
      ) p
      union
      select t.tenant_id, t.scope, t.scope_id, t.role from "permdock".custom_role_permissions t
      where t.scope = 'global' and t.tenant_id is null and t.role in (select jsonb_array_elements_text(held))
      union
      select t.tenant_id, t.scope, t.scope_id, t.role from "permdock".custom_role_includes t
      where t.scope = 'global' and t.tenant_id is null and t.role in (select jsonb_array_elements_text(held))
    ) c;
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
$$;
