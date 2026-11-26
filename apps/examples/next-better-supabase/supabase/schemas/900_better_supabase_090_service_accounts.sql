-- better-supabase module: service-accounts
-- @bsb-block service-accounts@1 managed
-- @bsb-hash sha256:6560f00318bbb4b7ca4067f942ae59551e45b104e92ccea54a80234548d19431
-- Non-human tenant members backed by auth.users rows that can't sign in, with roles through memberships. Organization-owned workflow versions and service webhook endpoints run as the tenant's default principal.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

-- Non-human members of a tenant. Each row is an auth.users row that can't
-- sign in (no password, banned, app_metadata.bsb_service_principal),
-- created through the Auth admin API, and holds its role through a tenant
-- membership like any member. Organization-owned workflow versions and
-- service webhook endpoints run as the tenant's default principal.
create table "better_supabase"."service_principals" (
  "id" uuid primary key references auth.users (id) on delete cascade,
  "tenant_id" uuid not null,
  "name" text not null constraint bsb_service_principals_name_check check (length("name") >= 1 and length("name") <= 120),
  "role" text not null constraint bsb_service_principals_role_check check (length("role") >= 1 and length("role") <= 200),
  "is_default" boolean not null default false,
  "created_by" uuid references auth.users (id) on delete set null,
  "created_at" timestamptz not null default now(),
  "disabled_at" timestamptz,
  unique ("tenant_id", "name")
);
create index service_principals_tenant_idx on "better_supabase"."service_principals" ("tenant_id");
create index service_principals_created_by_idx on "better_supabase"."service_principals" ("created_by");
create unique index service_principals_default_idx on "better_supabase"."service_principals" ("tenant_id")
  where "is_default" and "disabled_at" is null;
alter table "better_supabase"."service_principals" enable row level security;
revoke all on "better_supabase"."service_principals" from public, anon, authenticated;
grant select on "better_supabase"."service_principals" to authenticated;
grant all on "better_supabase"."service_principals" to service_role;

create policy bsb_service_principals_read on "better_supabase"."service_principals"
  for select to authenticated
  using ("tenant_id" in (select better_supabase.tenant_ids_with('service_accounts.read')));

-- Registers an auth.users row the service created for a principal and adds
-- its membership with role. The user must carry
-- app_metadata.bsb_service_principal and be banned, so a real account
-- never becomes one. With created_by, that member needs the manage
-- permission and may assign role. Service role only.

create or replace function "better_supabase"."register_service_principal"(principal uuid, tenant uuid, name text, role text, is_default boolean default false, created_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Service principals are managed by the service' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  if register_service_principal.created_by is not null and not (
    coalesce(better_supabase.member_can(register_service_principal.created_by, register_service_principal.tenant, 'service_accounts.manage'), false)
    and coalesce(better_supabase.can_assign_as(register_service_principal.created_by, register_service_principal.tenant, register_service_principal.role), false)
  ) then
    raise exception 'You may not manage service principals with this role' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = register_service_principal.principal
      and coalesce((u.raw_app_meta_data ->> 'bsb_service_principal')::boolean, false)
      and u.banned_until > now() + interval '50 years'
  ) then
    raise exception 'The user is not a service principal: create it with createServiceAccounts().create' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_USER';
  end if;
  if register_service_principal.is_default then
    update "better_supabase"."service_principals" set "is_default" = false
    where "tenant_id" = register_service_principal.tenant and "is_default";
  end if;
  insert into "better_supabase"."service_principals" ("id", "tenant_id", "name", "role", "is_default", "created_by")
  values (register_service_principal.principal, register_service_principal.tenant, register_service_principal.name,
    register_service_principal.role, coalesce(register_service_principal.is_default, false), register_service_principal.created_by);
  insert into "public"."organization_memberships" ("organization_id", "user_id", "role")
  values (register_service_principal.tenant, register_service_principal.principal, register_service_principal.role);
  perform better_supabase.audit_event(
    event_type => 'service_principal.created',
    category => 'access',
    target_type => 'service_principal',
    record_id => register_service_principal.principal::text,
    target_label => register_service_principal.name,
    tenant => (register_service_principal.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', register_service_principal.tenant::text, 'id', register_service_principal.principal, 'name', register_service_principal.name, 'role', register_service_principal.role),
    actor_id => coalesce(register_service_principal.created_by, auth.uid())
  );
  return jsonb_build_object('id', register_service_principal.principal, 'tenant', register_service_principal.tenant,
    'name', register_service_principal.name, 'role', register_service_principal.role,
    'isDefault', coalesce(register_service_principal.is_default, false));
end;
$$;
revoke execute on function "better_supabase"."register_service_principal"(uuid, uuid, text, text, boolean, uuid) from public, anon, authenticated;
grant execute on function "better_supabase"."register_service_principal"(uuid, uuid, text, text, boolean, uuid) to service_role;

-- Changes a principal's role and its membership. Service role only; with
-- created_by, that member needs the manage permission and may assign role.
create or replace function "better_supabase"."set_service_principal_role"(principal uuid, role text, created_by uuid default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_row "better_supabase"."service_principals";
begin
  select * into v_row from "better_supabase"."service_principals" p where p."id" = set_service_principal_role.principal and p."disabled_at" is null for update;
  if not found then
    raise exception 'No such service principal' using errcode = 'P0002', hint = 'SERVICE_PRINCIPAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Service principals are managed by the service' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  if set_service_principal_role.created_by is not null and not (
    coalesce(better_supabase.member_can(set_service_principal_role.created_by, v_row."tenant_id", 'service_accounts.manage'), false)
    and coalesce(better_supabase.can_assign_as(set_service_principal_role.created_by, v_row."tenant_id", set_service_principal_role.role), false)
  ) then
    raise exception 'You may not manage service principals with this role' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  update "better_supabase"."service_principals" set "role" = set_service_principal_role.role where "id" = v_row."id";
  update "public"."organization_memberships" set "role" = set_service_principal_role.role
  where "organization_id" = v_row."tenant_id" and "user_id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'service_principal.role_changed',
    category => 'access',
    target_type => 'service_principal',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'id', v_row."id", 'role', set_service_principal_role.role),
    actor_id => coalesce(set_service_principal_role.created_by, auth.uid())
  );
  return true;
end;
$$;
revoke execute on function "better_supabase"."set_service_principal_role"(uuid, text, uuid) from public, anon, authenticated;
grant execute on function "better_supabase"."set_service_principal_role"(uuid, text, uuid) to service_role;

-- Switches a principal off: it loses its membership and stops being the
-- default, so workflow steps and deliveries that resolve to it are refused.
-- The auth.users row stays for the audit trail. Service role only.
create or replace function "better_supabase"."disable_service_principal"(principal uuid, created_by uuid default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_row "better_supabase"."service_principals";
begin
  select * into v_row from "better_supabase"."service_principals" p where p."id" = disable_service_principal.principal and p."disabled_at" is null for update;
  if not found then
    return false;
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Service principals are managed by the service' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  if disable_service_principal.created_by is not null and not (
    coalesce(better_supabase.member_can(disable_service_principal.created_by, v_row."tenant_id", 'service_accounts.manage'), false)
    and coalesce(better_supabase.can_assign_as(disable_service_principal.created_by, v_row."tenant_id", v_row."role"), false)
  ) then
    raise exception 'You may not manage service principals with this role' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  update "better_supabase"."service_principals" set "disabled_at" = now(), "is_default" = false where "id" = v_row."id";
  delete from "public"."organization_memberships" where "organization_id" = v_row."tenant_id" and "user_id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'service_principal.disabled',
    category => 'access',
    target_type => 'service_principal',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'id', v_row."id"),
    actor_id => coalesce(disable_service_principal.created_by, auth.uid())
  );
  return true;
end;
$$;
revoke execute on function "better_supabase"."disable_service_principal"(uuid, uuid) from public, anon, authenticated;
grant execute on function "better_supabase"."disable_service_principal"(uuid, uuid) to service_role;

-- The tenant's default principal, or null. Workflow builder and webhook
-- delivery resolve organization-owned work to it.
create or replace function "better_supabase"."default_service_principal"(tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p."id" from "better_supabase"."service_principals" p
  where p."tenant_id" = default_service_principal.tenant and p."is_default" and p."disabled_at" is null
$$;
revoke execute on function "better_supabase"."default_service_principal"(uuid) from public, anon, authenticated;
grant execute on function "better_supabase"."default_service_principal"(uuid) to service_role;

-- The tenant's principals the caller may read, through the read policy.
create or replace function "better_supabase"."service_principals_list"(tenant uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p."id", 'name', p."name", 'role', p."role", 'isDefault', p."is_default",
    'createdBy', p."created_by", 'createdAt', p."created_at", 'disabledAt', p."disabled_at"
  ) order by p."name"), '[]'::jsonb)
  from "better_supabase"."service_principals" p
  where p."tenant_id" = service_principals_list.tenant
$$;
revoke execute on function "better_supabase"."service_principals_list"(uuid) from public, anon;
grant execute on function "better_supabase"."service_principals_list"(uuid) to authenticated, service_role;

-- The tenant's principals the caller may read, as a keyset page, by name (ADR 1077). filters is { role, isDefault, disabled (each a value or a list), search, sort (name, createdAt), direction, facet, count, limit, after, offset, paged, total, totalCap }.
create or replace function "better_supabase"."page_service_principals"(tenant uuid, filters jsonb default '{}')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_service_principals.filters, '{}'::jsonb);
  v_search text := case when nullif(trim(v_filters ->> 'search'), '') is null then null
    else '%' || replace(replace(replace(trim(v_filters ->> 'search'), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('role', 'isDefault', 'disabled') then
      raise exception 'facet is one of role, isDefault, disabled' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
    end if;
    with s as (
      select (case v_facet when 'role' then (x."role"::text)::text when 'isDefault' then (x."is_default"::text)::text when 'disabled' then ((x."disabled_at" is not null)::text)::text end) as v
      from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('name', 'createdAt') then
    raise exception 'sort is one of name, createdAt' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."name", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."name" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."name" <= (v_after ->> 0)::text and ((x."name" < (v_after ->> 0)::text) or (x."name" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."name" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."name", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."name" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."name" <= (v_after ->> 0)::text and ((x."name" < (v_after ->> 0)::text) or (x."name" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."name" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$$;
revoke execute on function "better_supabase"."page_service_principals"(uuid, jsonb) from public, anon;
grant execute on function "better_supabase"."page_service_principals"(uuid, jsonb) to authenticated, service_role;

-- Tenant isolation (ADR 0099): permissive policies combine with or, so one
-- the app adds would widen the block's. These restrictive policies keep each
-- table to the caller's organizations and what the block's policies grant.
create policy bsb_tenant_scope_select on "better_supabase"."service_principals" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('service_accounts.read')))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."service_principals" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."service_principals" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."service_principals" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));
