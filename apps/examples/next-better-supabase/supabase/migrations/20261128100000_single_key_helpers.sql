-- The PermDock helpers that check one grant key probe role_permissions by its
-- primary key, and the claim branch checks the signed-in user's active row once
-- per statement.

create or replace function "permdock".permdock_has(p_grant text)
returns boolean
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
#variable_conflict use_column
begin
  return (
  select "permdock".permdock_api_key_allows(p_grant) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null and coalesce((
  select exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = (select "permdock".permdock_user_id())
      and exists (select 1 from "permdock".role_permissions rp where rp.role = ur.role::text and rp.grant_key = p_grant and rp.scope = 'global')
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = (select "permdock".permdock_user_id())
      and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
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
  );
end;
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
#variable_conflict use_column
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
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and exists (select 1 from "permdock".role_permissions rp where rp.role = r.role and rp.grant_key = p_grant and rp.scope = 'organization')
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
#variable_conflict use_column
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
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and exists (select 1 from "permdock".role_permissions rp where rp.role = r.role and rp.grant_key = p_grant and rp.scope = 'customer')
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys)
  ) ids(id)
  where (select "permdock".permdock_api_key_allows(p_grant));
end;
$$;

create or replace function "permdock".permdock_has_for(p_user uuid, p_grant text)
returns boolean
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
#variable_conflict use_column
begin
  return (
  select exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = p_user
      and exists (select 1 from "permdock".role_permissions rp where rp.role = ur.role::text and rp.grant_key = p_grant and rp.scope = 'global')
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = p_user
      and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
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
  );
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
#variable_conflict use_column
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
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and exists (select 1 from "permdock".role_permissions rp where rp.role = r.role and rp.grant_key = p_grant and rp.scope = 'organization')
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
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
#variable_conflict use_column
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
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and exists (select 1 from "permdock".role_permissions rp where rp.role = r.role and rp.grant_key = p_grant and rp.scope = 'customer')
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
end;
$$;
