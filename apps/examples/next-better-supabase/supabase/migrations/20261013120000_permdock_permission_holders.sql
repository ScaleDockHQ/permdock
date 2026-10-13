-- permdock: permitted_<scope>_users for the organization and customer scopes, and permdock_actor_may_write for rls.readOnlyActors.

-- the users who hold a permission on one organization: its members and the global-role holders for whom the _for helpers answer; no client role may execute it
create or replace function "permdock".permitted_organization_users(p_permission text, p_id uuid)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key_0 "public"."memberships"."scope_id"%type := p_id;
begin
  return query
    select c.user_id
    from (
      select h.user_id::uuid
      from (
        select m."scope_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."memberships" m
        where m."scope"::text = 'organization' and m."scope_id" = v_key_0
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
$$;
revoke execute on function "permdock".permitted_organization_users(text, uuid) from public, anon, authenticated;

-- the users who hold a permission on one customer: its members and the global-role holders for whom the _for helpers answer; no client role may execute it
create or replace function "permdock".permitted_customer_users(p_permission text, p_id uuid)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key_0 "public"."memberships"."scope_id"%type := p_id;
  v_key_1 "public"."contacts"."customer_id"%type := p_id;
begin
  return query
    select c.user_id
    from (
      select h.user_id::uuid
      from (
        select m."scope_id"::text as id, m."user_id"::text as user_id, m."role"::text as role, null::text as via, true as live
        from "public"."memberships" m
        where m."scope"::text = 'customer' and m."scope_id" = v_key_0
      ) h
      union
      select h.user_id::uuid
      from (
        select m."customer_id"::text as id, m."user_id"::text as user_id, mf.role as role, 'contact'::text as via, true as live
        from "public"."contacts" m cross join lateral unnest(array['contact']::text[]) mf(role)
        where m."customer_id" = v_key_1
      ) h
      union
      select ur.user_id::uuid
      from "permdock".user_roles ur
    ) c(user_id)
    where c.user_id is not null
      and (
        p_id in (select "permdock".permitted_customer_ids_by_permission_for(c.user_id, p_permission))
        or "permdock".permdock_has_permission_for(c.user_id, p_permission)
      )
    order by 1;
end
$$;
revoke execute on function "permdock".permitted_customer_users(text, uuid) from public, anon, authenticated;

-- rls.readOnlyActors: false for a token whose act claim is a read-only support or impersonation session; hand-written write policies call it
create or replace function "permdock".permdock_actor_may_write()
returns boolean
language sql
stable
set search_path = ''
as $$
  select not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = any(array['support', 'impersonation']::text[]) or ((((select auth.jwt()) -> 'act') ->> 'kind') is null and ((select auth.jwt()) -> 'act') ? 'session_id'), false) or coalesce((((select auth.jwt()) -> 'act') ->> 'read_only') = 'false', false)
$$;
revoke execute on function "permdock".permdock_actor_may_write() from public, anon;
grant execute on function "permdock".permdock_actor_may_write() to authenticated;
