SET local check_function_bodies = off;

CREATE TABLE "public"."quote_overviews" (
  "organization_id" uuid    NOT NULL,
  "total"           integer NOT NULL DEFAULT 0,
  CONSTRAINT "quote_overviews_pkey" PRIMARY KEY (organization_id)
);

ALTER TABLE "public"."quote_overviews"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."quote_overviews" FROM "anon";

ALTER TABLE "public"."organizations"
  ADD COLUMN "status" text NOT NULL DEFAULT 'active'::text;

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
  suspended jsonb;
  extra jsonb;
  ver bigint;
begin
  claims := claims - 'attrs' - 'custom_roles_ver' - 'datetime_preferences' - 'features';
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
    pdk_plain as (
      select x.ord, x.entry, x.root_id,
        x.entry - 'scope' - 'id' - 'roles' - 'via' = '{}'::jsonb
          and jsonb_typeof(x.entry -> 'scope') = 'string'
          and coalesce(jsonb_typeof(x.entry -> 'via'), 'string') = 'string'
          and jsonb_typeof(x.entry -> 'id') = 'string'
          and jsonb_typeof(x.entry -> 'roles') = 'array'
          and not exists (select 1 from jsonb_array_elements(x.entry -> 'roles') v where jsonb_typeof(v) <> 'string') as plain
      from pdk_entries x
    ),
    pdk_tables as (
      select
        coalesce((select jsonb_agg(t.v order by t.v collate "C") from (select distinct p.entry ->> 'scope' as v from pdk_plain p where p.plain) t), '[]'::jsonb) as s,
        coalesce((select jsonb_agg(t.v order by t.v collate "C") from (select distinct r.v from pdk_plain p cross join lateral jsonb_array_elements_text(p.entry -> 'roles') as r(v) where p.plain) t), '[]'::jsonb) as r,
        coalesce((select jsonb_agg(t.v order by t.v collate "C") from (select distinct p.entry ->> 'via' as v from pdk_plain p where p.plain and p.entry ? 'via') t), '[]'::jsonb) as v
    ),
    pdk_items as (
      select p.ord, p.entry, p.root_id, p.plain,
        case when p.plain then
          jsonb_build_array(
            (select a.n - 1 from jsonb_array_elements_text(t.s) with ordinality as a(v, n) where a.v = p.entry ->> 'scope'),
            case when (p.entry ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then translate(rtrim(encode(decode(replace((p.entry ->> 'id'), '-', ''), 'hex'), 'base64'), '='), '+/', '-_') else '=' || (p.entry ->> 'id') end,
            coalesce((select a.n - 1 from jsonb_array_elements_text(t.v) with ordinality as a(v, n) where a.v = p.entry ->> 'via'), -1)
          ) || coalesce((
            select jsonb_agg(b.n - 1 order by q.o)
            from jsonb_array_elements_text(p.entry -> 'roles') with ordinality as q(v, o)
            join jsonb_array_elements_text(t.r) with ordinality as b(v, n) on b.v = q.v
          ), '[]'::jsonb)
        else p.entry end as item
      from pdk_plain p, pdk_tables t
    ),
    pdk_fixed as (
      select used + octet_length(pdk_roles.held::text) + octet_length(pdk_tables.s::text) + octet_length(pdk_tables.r::text) + octet_length(pdk_tables.v::text) + 44 + octet_length(case jsonb_array_length(pdk_roles.held) when 0 then '' when 1 then (pdk_roles.held -> 0)::text else pdk_roles.held::text end) + coalesce(octet_length(to_jsonb(active)::text), 0) + 20 + octet_length(pdk_version.ver::text) as bytes from pdk_roles, pdk_version, pdk_tables
    ),
    pdk_ranked as (
      select x.entry, x.item, x.plain, x.root_id is not distinct from active as current,
        row_number() over w as n,
        sum(octet_length(x.item::text)) over w as bytes
      from pdk_items x
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
    (select case when count(*) = 0 then '[]'::jsonb else jsonb_strip_nulls(jsonb_build_object(
        's', nullif((select t.s from pdk_tables t), '[]'::jsonb), 'r', nullif((select t.r from pdk_tables t), '[]'::jsonb), 'v', nullif((select t.v from pdk_tables t), '[]'::jsonb),
        'e', nullif(coalesce(jsonb_agg(k.item order by k.n) filter (where k.plain), '[]'::jsonb), '[]'::jsonb),
        'o', nullif(coalesce(jsonb_agg(k.item order by k.n) filter (where not k.plain), '[]'::jsonb), '[]'::jsonb)
      )) end from pdk_kept k),
    truncated or (select count(*) from pdk_ranked) > (select count(*) from pdk_kept),
    active is not null and coalesce((select bool_or(k.current) from pdk_ranked k), false),
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
  -- outside the memberships budget: the tenants the user is a member of while the tenant is suspended; a token refresh that reuses its claims keeps the claim it holds
  claims := claims - 'suspended_in';
  suspended := "permdock".suspended_in_for(uid);
  if suspended <> '[]'::jsonb then
    claims := jsonb_set(claims, '{suspended_in}', suspended);
  end if;
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));
    claims := jsonb_set(claims, '{custom_roles_ver}', to_jsonb("permdock".custom_roles_version_for(active::uuid)));
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
$function$;

CREATE OR REPLACE FUNCTION permdock.member_customer_ids()
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
    and jsonb_array_length(ms.roles) > 0
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_customer_ids_for (
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
  v_user_0 "public"."contacts"."user_id"%type := p_user;
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
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false);
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
    and jsonb_array_length(ms.roles) > 0
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select distinct (k ->> 'tenant')::uuid
  from (select ((select auth.jwt()) -> 'api_key') as k) api_key
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(k -> 'roles') when 'array' then k -> 'roles' else '[]'::jsonb end
  ) r(role)
  where jsonb_typeof(k) = 'object'
    and coalesce((select "permdock".permdock_user_id())::text, '') = ''
    and coalesce(k ->> 'tenant', '') <> ''
    and coalesce((k ->> 'tenant')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false);
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
    and jsonb_array_length(ms.roles) > 0
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false);
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
  ) x
  where (x.tenant is null or x.entry ? 'keep' or exists (select 1 from "public"."organizations" s where s."id"::text = x.tenant and s."status"::text = any(array['active']::text[])));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.memberships_for (
  p_user   uuid,
  p_tenant text
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
  ) x
  where x.tenant = p_tenant
    and (x.tenant is null or x.entry ? 'keep' or exists (select 1 from "public"."organizations" s where s."id"::text = x.tenant and s."status"::text = any(array['active']::text[])));
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
    or (coalesce(jsonb_array_length(subject -> 'memberships'), 0) = 0 and subject -> 'suspendedIn' is null) then
    return null;
  end if;
  return subject || jsonb_build_object('tenant', v_tenant::text);
end;
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
  select ids.id
  from (
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.keys
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
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys)
  ) ids(id)
  where (select "permdock".permdock_api_key_allows(p_grant));
end;
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
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.keys
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
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
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
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
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
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
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
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
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
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
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
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
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
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
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
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
  select ids.id
  from (
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys)
  union
  select (k ->> 'tenant')::uuid
  from (select ((select auth.jwt()) -> 'api_key') as k) api_key
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(k -> 'roles') when 'array' then k -> 'roles' else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where jsonb_typeof(k) = 'object'
    and coalesce((select "permdock".permdock_user_id())::text, '') = ''
    and coalesce(k ->> 'tenant', '') <> ''
    and coalesce((k ->> 'tenant')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
  ) ids(id)
  where (select "permdock".permdock_api_key_allows(p_grant));
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
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
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select (k ->> 'tenant')::uuid, rp.grant_key
  from (select ((select auth.jwt()) -> 'api_key') as k) api_key
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(k -> 'roles') when 'array' then k -> 'roles' else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where jsonb_typeof(k) = 'object'
    and coalesce((select "permdock".permdock_user_id())::text, '') = ''
    and coalesce(k ->> 'tenant', '') <> ''
    and coalesce((k ->> 'tenant')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
    and rp.scope = 'organization'
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
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
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
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
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select (k ->> 'tenant')::uuid, rp.grant_key
  from (select ((select auth.jwt()) -> 'api_key') as k) api_key
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(k -> 'roles') when 'array' then k -> 'roles' else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where jsonb_typeof(k) = 'object'
    and coalesce((select "permdock".permdock_user_id())::text, '') = ''
    and coalesce(k ->> 'tenant', '') <> ''
    and coalesce((k ->> 'tenant')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
    and rp.scope = 'organization'
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
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
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
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
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
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
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
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
  custom_versions jsonb := '{}'::jsonb;
  ver bigint;
  suspended jsonb := '[]'::jsonb;
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
  suspended := "permdock".suspended_in_for(uid);
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'name', c.role,
      'shared', case when c.tenant_id is null and c.scope <> 'global' then true end,
      'tenant', c.tenant_id::text,
      'scope', c.scope,
      'id', c.scope_id,
      'grants', c.grants,
      'includes', case when cardinality(c.includes) > 0 then to_jsonb(c.includes) end
    )) order by c.tenant_id::text, c.scope, c.scope_id, c.role), '[]'::jsonb)
    into custom
    from (
      select distinct c.tenant_id, c.scope, c.scope_id, c.role, c.grants, c.includes
      from (
        select m ->> 'scope' as scope, m ->> 'id' as id,
          case when m ->> 'scope' = 'organization' then m ->> 'id' else m -> 'within' ->> 'organization' end as tenant,
          r.role
        from jsonb_array_elements(memberships) m
        cross join lateral jsonb_array_elements_text(case when jsonb_typeof(m -> 'roles') = 'array' then m -> 'roles' else '[]'::jsonb end) r(role)
      ) h
      cross join lateral (
        select t.tenant_id, t.scope, t.scope_id, t.role, t.grants, t.includes from "permdock".custom_role_compiled t
        where t.scope = h.scope and t.role = h.role
          and (t.tenant_id is null and t.scope_id is null or t.tenant_id = h.tenant::uuid)
          and (t.scope_id is null or t.scope_id = h.id)
      ) c
      union
      select t.tenant_id, t.scope, t.scope_id, t.role, t.grants, t.includes from "permdock".custom_role_compiled t
      where t.scope = 'global' and t.tenant_id is null and t.role in (select jsonb_array_elements_text(held))
    ) c;
  -- the custom-role version of each tenant where a held role is a custom one, so a cached record is served only at the version it was read at
  select coalesce(jsonb_object_agg(v.tenant, "permdock".custom_roles_version_for(v.tenant::uuid)), '{}'::jsonb)
    into custom_versions
    from (
      select distinct case when m ->> 'scope' = 'organization' then m ->> 'id' else m -> 'within' ->> 'organization' end as tenant
      from jsonb_array_elements(memberships) m
      where exists (
        select 1 from jsonb_array_elements_text(case when jsonb_typeof(m -> 'roles') = 'array' then m -> 'roles' else '[]'::jsonb end) r(role)
        where r.role in (select k ->> 'name' from jsonb_array_elements(custom) k)
      )
    ) v
    where v.tenant is not null;
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
    'suspendedIn', case when suspended = '[]'::jsonb then null else suspended end,
    'customRoles', custom,
    'customRolesVersions', case when custom_versions = '{}'::jsonb then null else custom_versions end,
    'authzVersion', ver
  ));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.subject_for (
  p_user   uuid,
  p_tenant uuid
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
  custom_versions jsonb := '{}'::jsonb;
  ver bigint;
  suspended jsonb := '[]'::jsonb;
  claims jsonb := '{}'::jsonb;
  extra jsonb;
begin
  if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
    return null;
  end if;
  held := "permdock".global_roles_for(uid);
  select coalesce(jsonb_agg(x.entry order by x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text), '[]'::jsonb)
    into memberships
    from "permdock".memberships_for(uid, p_tenant::text) x;
  select case when ids ? p_tenant::text then jsonb_build_array(p_tenant::text) else '[]'::jsonb end
    into suspended
    from (select "permdock".suspended_in_for(uid) as ids) s;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'name', c.role,
      'shared', case when c.tenant_id is null and c.scope <> 'global' then true end,
      'tenant', c.tenant_id::text,
      'scope', c.scope,
      'id', c.scope_id,
      'grants', c.grants,
      'includes', case when cardinality(c.includes) > 0 then to_jsonb(c.includes) end
    )) order by c.tenant_id::text, c.scope, c.scope_id, c.role), '[]'::jsonb)
    into custom
    from (
      select distinct c.tenant_id, c.scope, c.scope_id, c.role, c.grants, c.includes
      from (
        select m ->> 'scope' as scope, m ->> 'id' as id,
          case when m ->> 'scope' = 'organization' then m ->> 'id' else m -> 'within' ->> 'organization' end as tenant,
          r.role
        from jsonb_array_elements(memberships) m
        cross join lateral jsonb_array_elements_text(case when jsonb_typeof(m -> 'roles') = 'array' then m -> 'roles' else '[]'::jsonb end) r(role)
      ) h
      cross join lateral (
        select t.tenant_id, t.scope, t.scope_id, t.role, t.grants, t.includes from "permdock".custom_role_compiled t
        where t.scope = h.scope and t.role = h.role
          and (t.tenant_id is null and t.scope_id is null or t.tenant_id = h.tenant::uuid)
          and (t.scope_id is null or t.scope_id = h.id)
      ) c
      union
      select t.tenant_id, t.scope, t.scope_id, t.role, t.grants, t.includes from "permdock".custom_role_compiled t
      where t.scope = 'global' and t.tenant_id is null and t.role in (select jsonb_array_elements_text(held))
    ) c;
  -- the custom-role version of each tenant where a held role is a custom one, so a cached record is served only at the version it was read at
  select coalesce(jsonb_object_agg(v.tenant, "permdock".custom_roles_version_for(v.tenant::uuid)), '{}'::jsonb)
    into custom_versions
    from (
      select distinct case when m ->> 'scope' = 'organization' then m ->> 'id' else m -> 'within' ->> 'organization' end as tenant
      from jsonb_array_elements(memberships) m
      where exists (
        select 1 from jsonb_array_elements_text(case when jsonb_typeof(m -> 'roles') = 'array' then m -> 'roles' else '[]'::jsonb end) r(role)
        where r.role in (select k ->> 'name' from jsonb_array_elements(custom) k)
      )
    ) v
    where v.tenant is not null;
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
    'suspendedIn', case when suspended = '[]'::jsonb then null else suspended end,
    'customRoles', custom,
    'customRolesVersions', case when custom_versions = '{}'::jsonb then null else custom_versions end,
    'authzVersion', ver
  ));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.suspended_in_for (
  p_user uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
  v_user_1 "public"."contacts"."user_id"%type := p_user;
  ids jsonb;
begin
  select coalesce(jsonb_agg(t.tenant order by t.tenant), '[]'::jsonb) into ids
  from (
    select distinct x.tenant
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
    ) x
    where x.tenant is not null
      and not (x.entry ? 'keep')
      and not exists (select 1 from "public"."organizations" s where s."id"::text = x.tenant and s."status"::text = any(array['active']::text[]))
    order by x.tenant
    limit 16
  ) t;
  return ids;
end;
$function$;

CREATE OR REPLACE FUNCTION public.quotes_overview_payload()
  RETURNS integer
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(sum(total), 0)::integer
  from public.quote_overviews
  where permdock.permdock_organization_has_active('quotes.list');
$function$;

REVOKE ALL ON FUNCTION "public"."quotes_overview_payload"() FROM PUBLIC, "anon";

ALTER TABLE "public"."organizations"
  ADD CONSTRAINT "organizations_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])));

ALTER TABLE "public"."quote_overviews"
  ADD CONSTRAINT "quote_overviews_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

CREATE POLICY "quote_overviews_select" ON "public"."quote_overviews"
  FOR SELECT
  TO "authenticated"
  USING ((organization_id IN ( SELECT permdock.permitted_organization_ids_by_permission('quotes.list'::text) AS permitted_organization_ids_by_permission)));

REVOKE ALL ON FUNCTION "permdock"."suspended_in_for"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."suspended_in_for"(uuid) TO "supabase_auth_admin";

GRANT EXECUTE ON FUNCTION "public"."quotes_overview_payload"() TO "authenticated";

REVOKE ALL ON FUNCTION "public"."quotes_overview_payload"() FROM "postgres";

GRANT EXECUTE ON FUNCTION "public"."quotes_overview_payload"() TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."quotes_overview_payload"() TO "service_role";

REVOKE ALL ON TABLE "public"."quote_overviews" FROM "authenticated";

GRANT SELECT ON TABLE "public"."quote_overviews" TO "authenticated";

REVOKE ALL ON TABLE "public"."quote_overviews" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."quote_overviews" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."quote_overviews" TO "service_role";
