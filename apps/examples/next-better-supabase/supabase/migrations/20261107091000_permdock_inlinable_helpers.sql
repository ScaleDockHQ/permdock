-- The row helpers lose the set_config memo (rls.memo defaults to none), and the role and approval indexes change shape.
SET local check_function_bodies = off;

DROP TRIGGER "permdock_memo_generation_truncate" ON "permdock"."custom_role_includes";

DROP TRIGGER "permdock_memo_generation" ON "permdock"."custom_role_includes";

DROP TRIGGER "permdock_memo_generation_truncate" ON "permdock"."custom_role_permissions";

DROP TRIGGER "permdock_memo_generation" ON "permdock"."custom_role_permissions";

DROP TRIGGER "permdock_memo_generation_truncate" ON "permdock"."role_permissions";

DROP TRIGGER "permdock_memo_generation" ON "permdock"."role_permissions";

DROP TRIGGER "permdock_memo_generation_truncate" ON "permdock"."user_roles";

DROP TRIGGER "permdock_memo_generation" ON "permdock"."user_roles";

DROP TRIGGER "permdock_memo_generation_truncate" ON "public"."contacts";

DROP TRIGGER "permdock_memo_generation" ON "public"."contacts";

DROP TRIGGER "permdock_memo_generation_truncate" ON "public"."organization_memberships";

DROP TRIGGER "permdock_memo_generation" ON "public"."organization_memberships";

DROP TRIGGER "permdock_memo_generation_truncate" ON "public"."roles";

DROP TRIGGER "permdock_memo_generation" ON "public"."roles";

DROP INDEX "permdock"."approval_requests_pending";

DROP INDEX "permdock"."custom_role_includes_key";

DROP INDEX "permdock"."custom_role_permissions_key";

DROP FUNCTION "permdock"."permdock_bump_memo_generation"();

DROP FUNCTION "permdock"."permdock_has"(text);

DROP FUNCTION "permdock"."permdock_memo_generation"();

DROP FUNCTION "permdock"."permdock_memo_put"(text, text);

CREATE OR REPLACE FUNCTION permdock.can_quotes (
  p_row        public.quotes,
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select "permdock".permitted_quotes_match(p_row, p_permission)
$function$;

CREATE OR REPLACE FUNCTION permdock.can_quotes (
  p_id         uuid,
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select exists (
    select 1 from "public"."quotes" as permdock_row
    where permdock_row."id" = p_id
      and "permdock".permitted_quotes_match(permdock_row, p_permission)
  )
$function$;

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
      and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
      'global'
    ))
  )
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has_for (
  p_user  uuid,
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
      and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
      'global'
    ))
  )
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has_permission (
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select exists (select 1 from "permdock".grant_keys(p_permission, 'global') g(grant_key) where "permdock".permdock_has(g.grant_key))
    and not exists (select 1 from "permdock".grant_keys(p_permission, 'global', 'deny') g(grant_key) where "permdock".permdock_has(g.grant_key))
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has_permission_for (
  p_user       uuid,
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select exists (select 1 from "permdock".grant_keys(p_permission, 'global') g(grant_key) where "permdock".permdock_has_for(p_user, g.grant_key))
    and not exists (select 1 from "permdock".grant_keys(p_permission, 'global', 'deny') g(grant_key) where "permdock".permdock_has_for(p_user, g.grant_key))
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids (
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
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
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
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'customer'
    ));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_by_permission (
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'customer') g(grant_key)
  cross join lateral "permdock".permitted_customer_ids(g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'customer', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_customer_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_by_permission (
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_customer_ids(g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_customer_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_by_permission_for (
  p_user       uuid,
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'customer') g(grant_key)
  cross join lateral "permdock".permitted_customer_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'customer', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_customer_ids_for(p_user, g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_by_permission_for (
  p_user        uuid,
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_customer_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'customer', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_customer_ids_for(p_user, g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_for (
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
  v_user_0 "public"."contacts"."user_id"%type := p_user;
begin
  return query
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
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'customer'
    ));
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
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
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
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
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
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
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
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
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
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'organization'
    ));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_by_permission (
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'organization') g(grant_key)
  cross join lateral "permdock".permitted_organization_ids(g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_organization_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_by_permission (
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_organization_ids(g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_organization_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_by_permission_for (
  p_user       uuid,
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'organization') g(grant_key)
  cross join lateral "permdock".permitted_organization_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_organization_ids_for(p_user, g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_by_permission_for (
  p_user        uuid,
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_organization_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_organization_ids_for(p_user, g.grant_key) d(id)
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
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'organization'
    ));
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

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_match (
  p_row        public.quotes,
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  with permdock_candidates as (select (p_row).*)
  select exists (select 1 from permdock_candidates where case p_permission
    when 'quotes.list' then coalesce((("organization_id" in (select "permdock".permitted_organization_ids('quotes.list'))) or ("customer_id" in (select "permdock".permitted_customer_ids('quotes.list')))), false)
    when 'quotes.read' then coalesce((("organization_id" in (select "permdock".permitted_organization_ids('quotes.read'))) or ("customer_id" in (select "permdock".permitted_customer_ids('quotes.read')))), false)
    when 'quotes.update' then coalesce(("organization_id" in (select "permdock".permitted_organization_ids('quotes.update'))), false)
    else false
  end)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_rows (
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select "id"::uuid from "public"."quotes" as permdock_row
  where "permdock".permitted_quotes_match(permdock_row, p_permission)
$function$;

CREATE INDEX approval_requests_pending_expires ON permdock.approval_requests USING btree (expires_at)
  WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX custom_role_includes_nnd_key ON permdock.custom_role_includes USING btree (tenant_id, scope, scope_id, ROLE, include_role) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX custom_role_permissions_nnd_key ON permdock.custom_role_permissions USING btree (tenant_id, scope, scope_id, ROLE, permission, effect) NULLS NOT DISTINCT;

REVOKE ALL ON FUNCTION "permdock"."permdock_has"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_has"(text) TO "authenticated";
