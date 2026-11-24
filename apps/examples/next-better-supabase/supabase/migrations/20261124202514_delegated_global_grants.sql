SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_has (
  p_grant text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and coalesce((
  select exists (
    select 1
    from "permdock".user_roles ur
    cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
    where ur.user_id = (select "permdock".permdock_user_id())
      and rp.grant_key = p_grant
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = (select "permdock".permdock_user_id())
      and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
      and p_grant in (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key))
  )
  ), false)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'customer')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))
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
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
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
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys (
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'customer')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))
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
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
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
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'organization')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))
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
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
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
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
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
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'organization')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))
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
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
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
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
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
