-- The PermDock helpers without a memo are plpgsql now, so Postgres keeps their
-- plans per session instead of planning a SQL body in every calling statement.

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
    cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
    where ur.user_id = (select "permdock".permdock_user_id())
      and rp.grant_key = p_grant
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
$$;

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
#variable_conflict use_column
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
$$;

create or replace function "permdock".member_organization_ids_for(p_user uuid)
returns setof uuid
language plpgsql
stable
security definer
cost 1000
set search_path = ''
as $$
#variable_conflict use_column
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
$$;

create or replace function "permdock".permitted_team_ids(p_grant text)
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
begin
  return query
  select ids.id
  from (
  select null::uuid where false -- no team memberships table configured
  ) ids(id)
  where (select "permdock".permdock_api_key_allows(p_grant));
end;
$$;

create or replace function "permdock".member_team_ids()
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
begin
  return query
  select null::uuid where false -- no team memberships table configured
  ;
end;
$$;

create or replace function "permdock".member_team_ids_for(p_user uuid, p_active text default null)
returns setof uuid
language plpgsql
stable
security definer
cost 1000
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  select null::uuid where false -- no team memberships table configured
  ;
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
$$;

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
#variable_conflict use_column
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
$$;

create or replace function "permdock".member_customer_ids_for(p_user uuid)
returns setof uuid
language plpgsql
stable
security definer
cost 1000
set search_path = ''
as $$
#variable_conflict use_column
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
    cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
    where ur.user_id = p_user
      and rp.grant_key = p_grant
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
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and coalesce((ms.id)::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
end;
$$;

create or replace function "permdock".permitted_team_ids_for(p_user uuid, p_grant text)
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
begin
  return query
  select null::uuid where false -- no team memberships table configured
  ;
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
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and coalesce((ms.within ->> 'organization')::uuid in (select s."id" from "public"."organizations" s where s."status"::text = any(array['active']::text[])), false)
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
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
#variable_conflict use_column
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
#variable_conflict use_column
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
$$;

create or replace function "permdock".permitted_team_permission_keys(p_id uuid)
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
#variable_conflict use_column
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'team')
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
  select null::uuid, null::text where false -- no team memberships table configured
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'team' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;

create or replace function "permdock".permitted_team_permission_keys(p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
#variable_conflict use_column
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'team')
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
  select null::uuid, null::text where false -- no team memberships table configured
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'team' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'deny'))
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
#variable_conflict use_column
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
#variable_conflict use_column
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
#variable_conflict use_column
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
#variable_conflict use_column
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
$$;

create or replace function "permdock".permitted_team_permission_keys_for(p_user uuid, p_id uuid)
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
#variable_conflict use_column
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'team')
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
  select null::uuid, null::text where false -- no team memberships table configured
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'team' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'deny'))
  order by 1;
end;
$$;

create or replace function "permdock".permitted_team_permission_keys_for(p_user uuid, p_id uuid, p_keys text[])
returns setof text
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
#variable_conflict use_column
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'team')
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
  select null::uuid, null::text where false -- no team memberships table configured
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'team' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'deny'))
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
#variable_conflict use_column
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
#variable_conflict use_column
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
$$;
