-- Custom roles are probed once per membership and their keys read once per distinct set of entries, quote rows read only the row inline, and the token hook reads its roles, memberships, teams and version in one statement.
create or replace function "permdock".permdock_has(p_grant text)
returns boolean
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
  select exists (
    select 1
    from "permdock".user_roles ur
    join "permdock".role_permissions rp on rp.role = ur.role::text
    where ur.user_id = (select "permdock".permdock_user_id())
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = (select "permdock".permdock_user_id())
      and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
      and p_grant in (select k.grant_key
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
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key))
  )
$$;

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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.id)::text end and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.within ->> 'organization')::text end and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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

create or replace function "permdock".permdock_has_for(p_user uuid, p_grant text)
returns boolean
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
  select exists (
    select 1
    from "permdock".user_roles ur
    join "permdock".role_permissions rp on rp.role = ur.role::text
    where ur.user_id = p_user
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = p_user
      and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
      and p_grant in (select k.grant_key
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
      cross join lateral "permdock".permdock_custom_keys(pdk_e.allow, pdk_e.deny, pdk_e.incl, 'global') k(grant_key))
  )
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.id)::text end and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.within ->> 'organization')::text end and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.id)::text end and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.id)::text end and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.within ->> 'organization')::text end and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.within ->> 'organization')::text end and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.id)::text end and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.id)::text end and i.scope = 'organization' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.within ->> 'organization')::text end and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
          select array(select i.include_role from "permdock".custom_role_includes i where case when pdk_s.shared then i.tenant_id is null else i.tenant_id::text = (ms.within ->> 'organization')::text end and i.scope = 'customer' and (i.scope_id is null or i.scope_id = (ms.id)::text) and i.role = r.role order by 1) as incl
        ) i
        cross join lateral (
          select
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
            coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny
          from "permdock".custom_role_permissions c
          where case when pdk_s.shared then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
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
    when 'quotes.list' then coalesce((("organization_id" in (select "permdock".permitted_organization_ids('quotes.list'))) or ("customer_id" in (select "permdock".permitted_customer_ids('quotes.list')))), false)
    when 'quotes.read' then coalesce((("organization_id" in (select "permdock".permitted_organization_ids('quotes.read'))) or ("customer_id" in (select "permdock".permitted_customer_ids('quotes.read')))), false)
    when 'quotes.update' then coalesce(("organization_id" in (select "permdock".permitted_organization_ids('quotes.update'))), false)
    else "permdock".permitted_quotes_match(permdock_row, p_permission)
  end
$$;

create or replace function "permdock".custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
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
  extra jsonb;
  ver bigint;
begin
  claims := claims - 'attrs' - 'datetime_preferences' - 'features';
  active := claims -> 'app_metadata' ->> 'tenant_id';
  -- one statement reads the roles, the memberships and the authorization version; the budget counts every slice
  with pdk_roles as (
      select "permdock".global_roles_for(uid) as held
    ),
    pdk_version as (
      select coalesce((select v.version from "permdock"."permdock_authz_version" v where v.user_id = uid), 0) as ver
    ),
    pdk_entries as (
      select e.ord, e.entry, case when e.entry ->> 'scope' = 'organization' then e.entry ->> 'id' else e.entry -> 'within' ->> 'organization' end as root_id
      from "permdock".memberships_for(uid) e
    ),
    pdk_fixed as (
      select used + octet_length(pdk_roles.held::text) + octet_length(pdk_version.ver::text) as bytes from pdk_roles, pdk_version
    ),
    pdk_ranked as (
      select x.entry, x.root_id is not distinct from active as current,
        row_number() over w as n,
        sum(octet_length(x.entry::text)) over w as bytes
      from pdk_entries x
      window w as (
        order by (x.root_id is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
        rows between unbounded preceding and current row
      )
    ),
    pdk_kept as (
      select r.* from pdk_ranked r, pdk_fixed f where f.bytes + 2 + r.bytes + 2 * (r.n - 1) <= budget
    )
  select
    (select pdk_roles.held from pdk_roles),
    coalesce((select jsonb_agg(k.entry order by k.n) from pdk_kept k), '[]'::jsonb),
    truncated or (select count(*) from pdk_ranked) > (select count(*) from pdk_kept),
    active is not null and coalesce((select bool_or(k.current) from pdk_kept k), false),
    (select bytes from pdk_fixed),
    (select pdk_version.ver from pdk_version)
  into held, kept, truncated, in_active, used, ver;
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
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
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(ver));
  return jsonb_set(event, '{claims}', claims);
end;
$$;
