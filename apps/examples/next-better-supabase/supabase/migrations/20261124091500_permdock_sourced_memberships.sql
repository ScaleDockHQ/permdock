create or replace function "permdock".permdock_token_current()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce((
    select to_jsonb(v.version) = (c.j -> 'authz_ver')
      and coalesce(c.j -> 'memberships_truncated', 'false'::jsonb) <> 'true'::jsonb
      and jsonb_typeof(c.j -> 'memberships') = 'array'
    from "permdock".permdock_authz_version v
    cross join (select auth.jwt() as j) c
    where v.user_id = (select "permdock".permdock_user_id())
  ), false);
end;
$$;

revoke execute on function "permdock".permdock_token_current() from public, anon;

grant execute on function "permdock".permdock_token_current() to authenticated;

create or replace function "permdock".permitted_organization_ids(p_grant text)
returns setof uuid
language sql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
  with pdk_m as (
  select m."organization_id"::uuid as id, pdk_e.keys
  from "public"."organization_memberships" m
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', m."role"::text) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (m."organization_id")::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = m."organization_id"::text) and c.role = m."role"::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where m."user_id" = (select "permdock".permdock_user_id())
    and not (m."role"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or m."organization_id"::text = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  )
  select (m ->> 'id')::uuid
  from (select coalesce(((select auth.jwt()) -> 'memberships'), (select auth.jwt()) -> 'app_metadata' -> 'memberships') as v) pdk_c
    cross join lateral jsonb_array_elements(
      case jsonb_typeof(pdk_c.v) when 'array' then pdk_c.v else '[]'::jsonb end
    ) m
    cross join lateral jsonb_array_elements_text(
      case jsonb_typeof(m -> 'roles') when 'array' then m -> 'roles' else '[]'::jsonb end
    ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and rp.grant_key = p_grant
    and (select "permdock".permdock_token_current())
    and m ->> 'scope' = 'organization'
    and m ->> 'id' is not null
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or m ->> 'id' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and case jsonb_typeof(m -> 'expires_at')
      when 'number' then (m ->> 'expires_at')::numeric > extract(epoch from now())
      else true
    end
  union
  select m."organization_id"::uuid
  from "public"."organization_memberships" m
  cross join lateral "permdock".permdock_role_grant_keys('organization', m."role"::text) rp(grant_key)
  where m."user_id" = (select "permdock".permdock_user_id())
    and not (select "permdock".permdock_token_current())
    and rp.grant_key = p_grant
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or m."organization_id"::text = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys)
$$;

create or replace function "permdock".member_organization_ids()
returns setof uuid
language sql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
  select distinct m."organization_id"::uuid
  from "public"."organization_memberships" m
  where m."user_id" = (select "permdock".permdock_user_id())
    and m."role" is not null
$$;

create or replace function "permdock".member_organization_ids_for(p_user uuid)
returns setof uuid
language sql
stable
security definer
cost 1000
set search_path = ''
as $$
  select distinct m."organization_id"::uuid
  from "public"."organization_memberships" m
  where m."user_id" = p_user
    and m."role" is not null
$$;

create or replace function "permdock".permitted_organization_ids_for(p_user uuid, p_grant text)
returns setof uuid
language sql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
  with pdk_m as (
  select m."organization_id"::uuid as id, pdk_e.keys
  from "public"."organization_memberships" m
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', m."role"::text) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (m."organization_id")::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = m."organization_id"::text) and c.role = m."role"::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where m."user_id" = p_user
    and not (m."role"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  )
  select m."organization_id"::uuid
  from "public"."organization_memberships" m
  cross join lateral "permdock".permdock_role_grant_keys('organization', m."role"::text) rp(grant_key)
  where m."user_id" = p_user
    and rp.grant_key = p_grant
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys)
$$;

create or replace function "permdock".permitted_organization_permission_keys(p_id uuid)
returns setof text
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
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
  select m."organization_id"::uuid, rp.grant_key
  from "public"."organization_memberships" m
  cross join lateral "permdock".permdock_role_grant_keys('organization', m."role"::text) rp(grant_key)
  where m."user_id" = (select "permdock".permdock_user_id())
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or m."organization_id"::text = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select m."organization_id"::uuid, ck.grant_key
  from "public"."organization_memberships" m
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', m."role"::text) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (m."organization_id")::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = m."organization_id"::text) and c.role = m."role"::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where m."user_id" = (select "permdock".permdock_user_id())
    and not (m."role"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or m."organization_id"::text = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
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
  order by 1
$$;

create or replace function "permdock".permitted_organization_permission_keys(p_id uuid, p_keys text[])
returns setof text
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
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
  select m."organization_id"::uuid, rp.grant_key
  from "public"."organization_memberships" m
  cross join lateral "permdock".permdock_role_grant_keys('organization', m."role"::text) rp(grant_key)
  where m."user_id" = (select "permdock".permdock_user_id())
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or m."organization_id"::text = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select m."organization_id"::uuid, ck.grant_key
  from "public"."organization_memberships" m
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', m."role"::text) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (m."organization_id")::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = m."organization_id"::text) and c.role = m."role"::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where m."user_id" = (select "permdock".permdock_user_id())
    and not (m."role"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or m."organization_id"::text = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
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
  order by 1
$$;

create or replace function "permdock".permitted_organization_permission_keys_for(p_user uuid, p_id uuid)
returns setof text
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
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
  select m."organization_id"::uuid, rp.grant_key
  from "public"."organization_memberships" m
  cross join lateral "permdock".permdock_role_grant_keys('organization', m."role"::text) rp(grant_key)
  where m."user_id" = p_user
  union
  select m."organization_id"::uuid, ck.grant_key
  from "public"."organization_memberships" m
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', m."role"::text) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (m."organization_id")::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = m."organization_id"::text) and c.role = m."role"::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where m."user_id" = p_user
    and not (m."role"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
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
  order by 1
$$;

create or replace function "permdock".permitted_organization_permission_keys_for(p_user uuid, p_id uuid, p_keys text[])
returns setof text
language sql
stable
security definer
cost 1000
parallel safe
set search_path = ''
set jit = off
as $$
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
  select m."organization_id"::uuid, rp.grant_key
  from "public"."organization_memberships" m
  cross join lateral "permdock".permdock_role_grant_keys('organization', m."role"::text) rp(grant_key)
  where m."user_id" = p_user
  union
  select m."organization_id"::uuid, ck.grant_key
  from "public"."organization_memberships" m
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', m."role"::text) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (m."organization_id")::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = m."organization_id"::text) and c.role = m."role"::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where m."user_id" = p_user
    and not (m."role"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
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
  order by 1
$$;

create or replace function "permdock".permitted_organization_users(p_permission text, p_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with pdk_h(user_id, grant_key) as (
  select m."user_id"::uuid, rp.grant_key
  from "public"."organization_memberships" m
  cross join lateral "permdock".permdock_role_grant_keys('organization', m."role"::text) rp(grant_key)
  where m."organization_id" = p_id
  union
  select m."user_id"::uuid, ck.grant_key
  from "public"."organization_memberships" m
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', m."role"::text) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (m."organization_id")::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = m."organization_id"::text) and c.role = m."role"::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where m."organization_id" = p_id
    and not (m."role"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_g(user_id, grant_key) as (
    select pdk_u.user_id, pdk_k.grant_key
    from (
      select distinct ur.user_id::uuid
      from "permdock".user_roles ur
      where ur.user_id is not null
    ) pdk_u(user_id)
    cross join lateral (
      select rp.grant_key
      from "permdock".user_roles ur
      cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
      where ur.user_id = pdk_u.user_id
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
      where ur.user_id = pdk_u.user_id
        and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_k(grant_key)
  )
  select h.user_id from pdk_h h
  where h.user_id is not null
    and h.grant_key in (select g.grant_key from "permdock".grant_keys(p_permission, 'organization') g(grant_key))
  except
  select h.user_id from pdk_h h
  where h.grant_key in (select g.grant_key from "permdock".grant_keys(p_permission, 'organization', 'deny') g(grant_key))
  union
  (select gh.user_id from pdk_g gh
  where gh.grant_key in (select g.grant_key from "permdock".grant_keys(p_permission, 'global') g(grant_key))
  except
  select gh.user_id from pdk_g gh
  where gh.grant_key in (select g.grant_key from "permdock".grant_keys(p_permission, 'global', 'deny') g(grant_key)))
  order by 1
$$;

create or replace function "permdock".permdock_holders_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids text[] := '{}';
  v_id text;
  v_key "public"."organization_memberships"."organization_id"%type;
  v_total bigint;
  v_count bigint;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_ids := v_ids || old."organization_id"::text;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_ids := v_ids || new."organization_id"::text;
  end if;
  foreach v_id in array v_ids loop
    continue when v_id is null;
    v_key := v_id;
    select count(*) into v_total from "public"."organization_memberships" m where m."organization_id" = v_key;
    select count(distinct m."user_id") into v_count
      from "public"."organization_memberships" m
      where m."organization_id" = v_key
        and m."role"::text = 'owner';
    if v_total > 0 and v_count < 1 then
      raise exception using
        errcode = '23514',
        hint = 'last-holder',
        message = 'permdock: organization ' || v_id || ' keeps at least 1 owner';
    end if;
  end loop;
  return null;
end;
$$;
