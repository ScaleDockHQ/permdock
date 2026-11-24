SET local check_function_bodies = off;

DROP POLICY "approval_delegations_insert" ON "permdock"."approval_delegations";

DROP POLICY "approval_delegations_update" ON "permdock"."approval_delegations";

DROP POLICY "quotes_select" ON "public"."quotes";

DROP POLICY "quotes_update" ON "public"."quotes";

DROP POLICY "roles_read_members" ON "public"."roles";

DROP POLICY "staff_select" ON "public"."staff";

DROP FUNCTION "permdock"."member_organization_ids"();

DROP FUNCTION "permdock"."member_organization_ids_for"(uuid);

DROP FUNCTION "permdock"."permdock_token_current"();

DROP FUNCTION "permdock"."permitted_organization_ids"(text);

DROP FUNCTION "permdock"."permitted_organization_ids_for"(uuid, text);

DROP FUNCTION "permdock"."permitted_organization_permission_keys"(uuid);

DROP FUNCTION "permdock"."permitted_organization_permission_keys"(uuid, text[]);

DROP FUNCTION "permdock"."permitted_organization_permission_keys_for"(uuid, uuid);

DROP FUNCTION "permdock"."permitted_organization_permission_keys_for"(uuid, uuid, text[]);

DROP FUNCTION "permdock"."permitted_organization_users"(text, uuid);

CREATE OR REPLACE FUNCTION permdock.grant_keys (
  p_permission text,
  p_scope      text,
  p_effect     text DEFAULT 'allow'::text
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  return query
  select k.grant_key
  from "permdock".permission_keys k
  where k.scope = p_scope
    and k.permission = p_permission
    and k.effect = pg_catalog.replace(p_effect, 'conditioned-', '')
    and k.conditioned = (p_effect in ('conditioned-allow', 'conditioned-deny'));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_organization_ids()
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION permdock.member_organization_ids_for (
  p_user uuid
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
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
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
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
    select k.n from "permdock".permitted_organization_permission_keys(null::uuid) h(key) join pdk_k k on k.key = h.key
    where exists (
      select 1 from "permdock".permission_keys v
      where v.permission = k.key and v.scope = 'global' and v.effect = 'allow' and not v.conditioned
    )
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'apiVersion', 1,
    'form', 'compact',
    'keys', coalesce((select jsonb_agg(k.key order by k.n) from pdk_k k), '[]'::jsonb),
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

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys_for (
  p_user uuid,
  p_id   uuid
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
  v_user_0 "public"."contacts"."user_id"%type := p_user;
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
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
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
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys_for (
  p_user uuid,
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
  v_user_0 "public"."contacts"."user_id"%type := p_user;
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
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
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
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
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
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.keys
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
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
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
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_for (
  p_user  uuid,
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.keys
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
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
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
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
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

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid
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
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
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
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
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
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
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
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
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
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
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
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
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

CREATE OR REPLACE FUNCTION permdock.permitted_organization_users (
  p_permission text,
  p_id         uuid
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_key_0 "public"."organization_memberships"."organization_id"%type := p_id;
begin
  return query
    select c.user_id
    from (
      select h.user_id::uuid
      from (
        select m."organization_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."organization_memberships" m
        where m."organization_id" = v_key_0
      ) h
      union
      select ur.user_id::uuid
      from "permdock".user_roles ur
    ) c(user_id)
    where c.user_id is not null
      and (
        p_id in (select "permdock".permitted_organization_ids_by_permission_for(c.user_id, p_permission))
        or "permdock".permdock_has_permission_for(c.user_id, p_permission)
      )
    order by 1;
end
$function$;

CREATE VIEW "permdock"."permission_keys" WITH (security_invoker=true) AS  SELECT permission,
    scope,
    effect,
    grant_key,
    conditioned
   FROM ( VALUES ('quotes.list'::text,'customer'::text,'allow'::text,'quotes.list'::text,false), ('quotes.read'::text,'customer'::text,'allow'::text,'quotes.read'::text,false), ('audit.read'::text,'organization'::text,'allow'::text,'audit.read'::text,false), ('audit.revert'::text,'organization'::text,'allow'::text,'audit.revert'::text,false), ('quotes.list'::text,'organization'::text,'allow'::text,'quotes.list'::text,false), ('quotes.read'::text,'organization'::text,'allow'::text,'quotes.read'::text,false), ('quotes.update'::text,'organization'::text,'allow'::text,'quotes.update'::text,false), ('roles.manage'::text,'organization'::text,'allow'::text,'roles.manage'::text,false), ('staff.list'::text,'organization'::text,'allow'::text,'staff.list'::text,false), ('staff.read'::text,'organization'::text,'allow'::text,'staff.read'::text,false)) v(permission, scope, effect, grant_key, conditioned);

CREATE POLICY "approval_delegations_insert" ON "permdock"."approval_delegations"
  FOR INSERT
  TO "authenticated"
  WITH
    CHECK
    (((delegator = ( SELECT permdock.permdock_user_id() AS permdock_user_id)) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write) AND ((tenant IS NULL) OR
    (tenant IN ( SELECT (m.id)::text AS id
   FROM permdock.member_organization_ids() m(id))))));

CREATE POLICY "approval_delegations_update" ON "permdock"."approval_delegations"
  FOR UPDATE
  TO "authenticated"
  USING (((delegator = ( SELECT permdock.permdock_user_id() AS permdock_user_id)) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)))
  WITH
    CHECK
    (((delegator = ( SELECT permdock.permdock_user_id() AS permdock_user_id)) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write) AND ((tenant IS NULL) OR
    (tenant IN ( SELECT (m.id)::text AS id
   FROM permdock.member_organization_ids() m(id))))));

CREATE POLICY "quotes_select" ON "public"."quotes"
  FOR SELECT
  TO "authenticated"
  USING
    (((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.read'::text) AS permitted_organization_ids))) OR (customer_id = ANY (ARRAY( SELECT
    permdock.permitted_customer_ids('quotes.read'::text) AS permitted_customer_ids))) OR
    ((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.list'::text) AS permitted_organization_ids))) OR (customer_id = ANY (ARRAY( SELECT
    permdock.permitted_customer_ids('quotes.list'::text) AS permitted_customer_ids))))));

CREATE POLICY "quotes_update" ON "public"."quotes"
  FOR UPDATE
  TO "authenticated"
  USING ((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.update'::text) AS permitted_organization_ids))))
  WITH CHECK ((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.update'::text) AS permitted_organization_ids))));

CREATE POLICY "roles_read_members" ON "public"."roles"
  FOR SELECT
  TO "authenticated"
  USING ((organization_id IN ( SELECT permdock.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "staff_select" ON "public"."staff"
  FOR SELECT
  TO "authenticated"
  USING
    (((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('staff.read'::text) AS permitted_organization_ids))) OR (organization_id = ANY (ARRAY( SELECT
    permdock.permitted_organization_ids('staff.list'::text) AS permitted_organization_ids)))));

REVOKE ALL ON FUNCTION "permdock"."member_organization_ids"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."member_organization_ids"() TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."member_organization_ids_for"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."member_organization_ids_for"(uuid) TO "supabase_auth_admin";

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_ids"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_organization_ids"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_ids_for"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_permission_keys"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_organization_permission_keys"(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_permission_keys"(uuid, text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_organization_permission_keys"(uuid, text[]) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_permission_keys_for"(uuid, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_permission_keys_for"(uuid, uuid, text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_users"(text, uuid) FROM PUBLIC;

GRANT SELECT ON TABLE "permdock"."permission_keys" TO "authenticated";
