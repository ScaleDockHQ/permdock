-- save a custom role by its row id: the row supplies tenant, scope, instance and name; the caller checks of permdock_replace_custom_role_grants apply, and stored denies and includes stay
create or replace function "permdock".permdock_replace_custom_role_grants_by_id(p_role_id "public"."app_roles"."id"%type, p_permissions text[])
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
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'org' end, null::text, r."name"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."app_roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null'),
      hint = 'unknown-role';
  end if;
  if v_skipped or v_key = any(array['owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role',
      hint = 'declared-role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key;
  perform "permdock".permdock_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "actor_kind" => 'user');
end;
$$;
revoke execute on function "permdock".permdock_replace_custom_role_grants_by_id("public"."app_roles"."id"%type, text[]) from public, anon;
grant execute on function "permdock".permdock_replace_custom_role_grants_by_id("public"."app_roles"."id"%type, text[]) to authenticated;

-- save a custom role by its row id for a trusted caller: the definition checks without the caller checks
create or replace function "permdock".permdock_trusted_replace_custom_role_grants_by_id(p_role_id "public"."app_roles"."id"%type, p_permissions text[])
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
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'org' end, null::text, r."name"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."app_roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null'),
      hint = 'unknown-role';
  end if;
  if v_skipped or v_key = any(array['owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role',
      hint = 'declared-role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key;
  perform "permdock".permdock_trusted_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "actor_kind" => 'user');
end;
$$;
revoke execute on function "permdock".permdock_trusted_replace_custom_role_grants_by_id("public"."app_roles"."id"%type, text[]) from public, anon, authenticated;

-- the declared allow keys of custom roles by their row ids as text, for a trusted reader; with p_tenant, an id of another tenant is refused
create or replace function "permdock".permdock_trusted_role_permissions_by_id(p_role_ids text[], p_tenant uuid default null)
returns table (role_id text, permission text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_tenant is not null and exists (
    select 1 from "public"."app_roles" r
    where r."id"::text = any(p_role_ids) and r."organization_id"::uuid is distinct from p_tenant
  ) then
    raise exception using
      errcode = '42501',
      message = 'permdock: a role id belongs to another tenant than ' || p_tenant::text,
      hint = 'not-member';
  end if;
  return query
  select distinct v.role_id, (case c.permission when 'file.read' then 'doc.read' else c.permission end)
  from (
    select r."id"::text as role_id, r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'org' end as scope, null::text as scope_id, r."name"::text as role
    from "public"."app_roles" r
    where r."id"::text = any(p_role_ids)
      and not (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
      and not (r."name"::text = any(array['owner']::text[]))
  ) v
  join "permdock".custom_role_permissions c
    on c.tenant_id is not distinct from v.tenant_id
    and c.scope = v.scope
    and c.scope_id is not distinct from v.scope_id
    and c.role = v.role
  where c.effect = 'allow'
    and (case c.permission when 'file.read' then 'doc.read' else c.permission end) = any(array['doc.read', 'doc.update']::text[])
  order by 1, 2;
end;
$$;
revoke execute on function "permdock".permdock_trusted_role_permissions_by_id(text[], uuid) from public, anon, authenticated;
grant usage on schema "permdock" to "service_role";
grant execute on function "permdock".permdock_trusted_role_permissions_by_id(text[], uuid) to "service_role";