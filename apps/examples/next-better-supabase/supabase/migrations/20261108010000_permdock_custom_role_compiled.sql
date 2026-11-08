-- permdock custom roles: compiled roles, one version per tenant, token shape
create table "permdock".custom_role_version (
  tenant_id uuid,
  version bigint not null default 0
);

create unique index custom_role_version_key on "permdock".custom_role_version (tenant_id) nulls not distinct;

alter table "permdock".custom_role_version enable row level security;

revoke all on table "permdock".custom_role_version from anon, authenticated, public;

create table "permdock".custom_role_compiled (
  tenant_id uuid,
  scope text not null,
  scope_id text,
  role text not null,
  grant_keys text[] not null default '{}',
  grants jsonb not null default '[]'::jsonb,
  includes text[] not null default '{}',
  version bigint not null default 0
);

create unique index custom_role_compiled_role_key on "permdock".custom_role_compiled (tenant_id, scope, role, scope_id) nulls not distinct;

alter table "permdock".custom_role_compiled enable row level security;

revoke all on table "permdock".custom_role_compiled from anon, authenticated, public;

create or replace function "permdock".permdock_compile_custom_role(p_tenant uuid, p_scope text, p_role text, p_version bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from "permdock".custom_role_compiled c
  where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and c.role = p_role;
  insert into "permdock".custom_role_compiled (tenant_id, scope, scope_id, role, grant_keys, grants, includes, version)
  select p_tenant, p_scope, pin.scope_id, p_role,
    array(select k from "permdock".permdock_custom_keys(e.allow, e.deny, e.incl, p_scope) k order by 1),
    own.grants, own.incl, p_version
  from (
    select c.scope_id from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and c.role = p_role
    union
    select c.scope_id from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and c.role = p_role
  ) pin
  cross join lateral (
    select
      coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
      coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny,
      array(
        select i.include_role from "permdock".custom_role_includes i
        where (p_tenant is null and i.tenant_id is null or i.tenant_id = p_tenant) and i.scope = p_scope and i.role = p_role and (i.scope_id is null or i.scope_id = pin.scope_id)
        order by 1
      ) as incl
    from "permdock".custom_role_permissions c
    where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and c.role = p_role and (c.scope_id is null or c.scope_id = pin.scope_id)
  ) e
  cross join lateral (
    select
      coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'permission', c.permission, 'effect', c.effect, 'level', to_jsonb(c) ->> 'level'
      )) order by c.permission, c.effect), '[]'::jsonb) as grants,
      array(
        select i.include_role from "permdock".custom_role_includes i
        where (p_tenant is null and i.tenant_id is null or i.tenant_id = p_tenant) and i.scope = p_scope and i.role = p_role and i.scope_id is not distinct from pin.scope_id
        order by 1
      ) as incl
    from "permdock".custom_role_permissions c
    where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and c.role = p_role and c.scope_id is not distinct from pin.scope_id
  ) own;
end;
$$;

revoke execute on function "permdock".permdock_compile_custom_role(uuid, text, text, bigint) from public, anon, authenticated;

create or replace function "permdock".permdock_compile_custom_roles_for(p_owners uuid[], p_scopes text[], p_roles text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
begin
  insert into "permdock".custom_role_version as v (tenant_id, version)
  select distinct u, 1 from unnest(p_owners) u
  on conflict (tenant_id) do update set version = v.version + 1;
  for r in
    select distinct u.own_id, u.scope, u.role, (
      select v.version from "permdock".custom_role_version v where v.tenant_id is not distinct from u.own_id
    ) as version
    from unnest(p_owners, p_scopes, p_roles) u(own_id, scope, role)
  loop
    perform "permdock".permdock_compile_custom_role(r.own_id, r.scope, r.role, r.version);
  end loop;
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is not null then
    for r in
      select v.tenant_id, v.version from "permdock".custom_role_version v
      where v.tenant_id in (select u from unnest(p_owners) u)
        or (v.tenant_id is null and exists (select 1 from unnest(p_owners) u where u is null))
    loop
      perform realtime.send(
        jsonb_build_object('tenant', r.tenant_id, 'version', r.version),
        'custom_roles'::text,
        (case when r.tenant_id is null then 'better_supabase:authz' else 'authz-tenant:' || r.tenant_id::text end)::text,
        true
      );
    end loop;
  end if;
end;
$$;

revoke execute on function "permdock".permdock_compile_custom_roles_for(uuid[], text[], text[]) from public, anon, authenticated;

create or replace function "permdock".permdock_compile_custom_roles_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owners uuid[];
  v_scopes text[];
  v_roles text[];
begin
  select array_agg(t.tenant_id), array_agg(t.scope), array_agg(t.role) from (select distinct tenant_id, scope, role from permdock_new) t
  into v_owners, v_scopes, v_roles;
  perform "permdock".permdock_compile_custom_roles_for(v_owners, v_scopes, v_roles);
  return null;
end;
$$;

revoke execute on function "permdock".permdock_compile_custom_roles_insert() from public, anon, authenticated;

create or replace function "permdock".permdock_compile_custom_roles_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owners uuid[];
  v_scopes text[];
  v_roles text[];
begin
  select array_agg(t.tenant_id), array_agg(t.scope), array_agg(t.role)
    from (select tenant_id, scope, role from permdock_old union select tenant_id, scope, role from permdock_new) t
  into v_owners, v_scopes, v_roles;
  perform "permdock".permdock_compile_custom_roles_for(v_owners, v_scopes, v_roles);
  return null;
end;
$$;

revoke execute on function "permdock".permdock_compile_custom_roles_update() from public, anon, authenticated;

create or replace function "permdock".permdock_compile_custom_roles_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owners uuid[];
  v_scopes text[];
  v_roles text[];
begin
  select array_agg(t.tenant_id), array_agg(t.scope), array_agg(t.role) from (select distinct tenant_id, scope, role from permdock_old) t
  into v_owners, v_scopes, v_roles;
  perform "permdock".permdock_compile_custom_roles_for(v_owners, v_scopes, v_roles);
  return null;
end;
$$;

revoke execute on function "permdock".permdock_compile_custom_roles_delete() from public, anon, authenticated;

create or replace trigger "permdock_custom_roles_compile_permissions_insert"
  after insert on "permdock".custom_role_permissions
  referencing new table as permdock_new
  for each statement execute function "permdock".permdock_compile_custom_roles_insert();

create or replace trigger "permdock_custom_roles_compile_permissions_update"
  after update on "permdock".custom_role_permissions
  referencing old table as permdock_old new table as permdock_new
  for each statement execute function "permdock".permdock_compile_custom_roles_update();

create or replace trigger "permdock_custom_roles_compile_permissions_delete"
  after delete on "permdock".custom_role_permissions
  referencing old table as permdock_old
  for each statement execute function "permdock".permdock_compile_custom_roles_delete();

create or replace trigger "permdock_custom_roles_compile_includes_insert"
  after insert on "permdock".custom_role_includes
  referencing new table as permdock_new
  for each statement execute function "permdock".permdock_compile_custom_roles_insert();

create or replace trigger "permdock_custom_roles_compile_includes_update"
  after update on "permdock".custom_role_includes
  referencing old table as permdock_old new table as permdock_new
  for each statement execute function "permdock".permdock_compile_custom_roles_update();

create or replace trigger "permdock_custom_roles_compile_includes_delete"
  after delete on "permdock".custom_role_includes
  referencing old table as permdock_old
  for each statement execute function "permdock".permdock_compile_custom_roles_delete();

create or replace function "permdock".permdock_recompile_custom_roles()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from "permdock".custom_role_compiled;
  perform "permdock".permdock_compile_custom_roles_for(
    array(select t.tenant_id from (select distinct tenant_id, scope, role from "permdock".custom_role_permissions union select tenant_id, scope, role from "permdock".custom_role_includes) t order by t.tenant_id, t.scope, t.role),
    array(select t.scope from (select distinct tenant_id, scope, role from "permdock".custom_role_permissions union select tenant_id, scope, role from "permdock".custom_role_includes) t order by t.tenant_id, t.scope, t.role),
    array(select t.role from (select distinct tenant_id, scope, role from "permdock".custom_role_permissions union select tenant_id, scope, role from "permdock".custom_role_includes) t order by t.tenant_id, t.scope, t.role)
  );
end;
$$;

revoke execute on function "permdock".permdock_recompile_custom_roles() from public, anon, authenticated;

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
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
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
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
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
  where p_grant = any(pdk_m.keys);
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
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
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
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
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
  where p_grant = any(pdk_m.keys);
end;
$$;

create or replace function "permdock".permdock_custom_role_guard(p_tenant uuid, p_scope text, p_scope_id text, p_role text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond(p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      message = 'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out',
      hint = 'not-assignable-by';
  end if;
end;
$$;

create or replace function "permdock".permdock_custom_role_guard_for(p_user uuid, p_tenant uuid, p_scope text, p_scope_id text, p_role text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond_for(p_user, p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      message = 'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out',
      hint = 'not-assignable-by';
  end if;
end;
$$;

create or replace function "permdock".permdock_replace_custom_role_grants(p_tenant uuid, p_scope text, p_scope_id text, p_role text, p_allow text[], p_deny text[], p_include text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
      message = 'permdock: ' || p_role || ' would allow ' || v_beyond || ', which the caller may not hand out',
      hint = 'not-assignable-by';
  end if;
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_role) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_role || ' is the name of a shared custom role',
      hint = 'name-taken';
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
$$;

create or replace function "permdock".permdock_rename_custom_role_grants(p_tenant uuid, p_scope text, p_scope_id text, p_from text, p_to text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform "permdock".permdock_custom_role_guard(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role',
      hint = 'name-taken';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name',
      hint = 'declared-role';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' already has grants',
      hint = 'role-exists';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
end;
$$;

create or replace function "permdock".permdock_delete_custom_role_grants(p_tenant uuid, p_scope text, p_scope_id text, p_role text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform "permdock".permdock_custom_role_guard(p_tenant, p_scope, p_scope_id, p_role);
  delete from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  delete from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
end;
$$;

create or replace function "permdock".permdock_trusted_replace_custom_role_grants(p_tenant uuid, p_scope text, p_scope_id text, p_role text, p_allow text[], p_deny text[], p_include text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  perform "permdock".permdock_custom_role_entries(p_scope, p_allow, p_deny, p_include);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_role) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_role || ' is the name of a shared custom role',
      hint = 'name-taken';
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
$$;

create or replace function "permdock".permdock_trusted_rename_custom_role_grants(p_tenant uuid, p_scope text, p_scope_id text, p_from text, p_to text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role',
      hint = 'name-taken';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name',
      hint = 'declared-role';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' already has grants',
      hint = 'role-exists';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
end;
$$;

create or replace function "permdock".permdock_trusted_delete_custom_role_grants(p_tenant uuid, p_scope text, p_scope_id text, p_role text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  delete from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  delete from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
end;
$$;

create or replace function "permdock".permdock_cascade_custom_role()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
      message = 'permdock: ' || v_new_key || ' already has grants',
      hint = 'role-exists';
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
$$;

create or replace function "permdock".permdock_sync_custom_role_permissions()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
    v_include := array(select c.include_role from "permdock".custom_role_includes c where (v.tenant_id is null and c.tenant_id is null or c.tenant_id = v.tenant_id) and c.scope = v.scope and (v.scope_id is null and c.scope_id is null or c.scope_id = v.scope_id) and c.role = v.role);
    perform set_config('permdock.sync', 'on', true);
    perform "permdock".permdock_trusted_replace_custom_role_grants(v.tenant_id, v.scope, v.scope_id, v.role, v_allow, v_deny, v_include);
    perform set_config('permdock.sync', '', true);
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
$$;

create or replace function "permdock".permdock_replace_custom_role_grants_by_id(p_role_id "public"."roles"."id"%type, p_permissions text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null'),
      hint = 'unknown-role';
  end if;
  if v_skipped or v_key = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role',
      hint = 'declared-role';
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
$$;

create or replace function "permdock".permdock_trusted_replace_custom_role_grants_by_id(p_role_id "public"."roles"."id"%type, p_permissions text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null'),
      hint = 'unknown-role';
  end if;
  if v_skipped or v_key = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role',
      hint = 'declared-role';
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
$$;

create or replace function "permdock".permdock_trusted_role_permissions_by_id(p_role_ids text[], p_tenant uuid default null)
returns table (role_id text, permission text)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    on (v.tenant_id is null and c.tenant_id is null or c.tenant_id = v.tenant_id)
    and c.scope = v.scope
    and (v.scope_id is null and c.scope_id is null or c.scope_id = v.scope_id)
    and c.role = v.role
  where c.effect = 'allow'
    and c.permission = any(array['audit.read', 'audit.revert', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])
  order by 1, 2;
end;
$$;

create or replace function "permdock".permdock_role_permissions(p_role text, p_scope text, p_tenant uuid default null, p_scope_id text default null)
returns table (permission text, effect text)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform'),
      hint = 'not-member';
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
$$;

create or replace function "permdock".permdock_trusted_role_permissions(p_role text, p_scope text, p_tenant uuid default null, p_scope_id text default null)
returns table (permission text, effect text)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    pdk_fixed as (
      select used + octet_length(pdk_roles.held::text) + octet_length(case jsonb_array_length(pdk_roles.held) when 0 then '' when 1 then (pdk_roles.held -> 0)::text else pdk_roles.held::text end) + coalesce(octet_length(to_jsonb(active)::text), 0) + 20 + octet_length(pdk_version.ver::text) as bytes from pdk_roles, pdk_version
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
$$;

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
  custom_versions jsonb := '{}'::jsonb;
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
    'customRoles', custom,
    'customRolesVersions', case when custom_versions = '{}'::jsonb then null else custom_versions end,
    'authzVersion', ver
  ));
end;
$$;

create or replace function "permdock".custom_roles_version_for(p_tenant uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(v.version), 0)::bigint from "permdock".custom_role_version v
  where v.tenant_id = p_tenant or v.tenant_id is null
$$;

revoke execute on function "permdock".custom_roles_version_for(uuid) from public, anon, authenticated;

grant execute on function "permdock".custom_roles_version_for(uuid) to supabase_auth_admin;

-- compile the roles stored before this migration
select permdock.permdock_recompile_custom_roles();
