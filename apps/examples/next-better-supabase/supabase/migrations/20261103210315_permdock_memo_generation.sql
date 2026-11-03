SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.permdock_bump_authz_version_for (
  p_users uuid[]
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  insert into "permdock"."permdock_authz_version" as v (user_id, version)
  select distinct u, 1 from unnest(p_users) u
  where u is not null and exists (select 1 from auth.users au where au.id = u)
  on conflict (user_id) do update set version = v.version + 1;
  select set_config(
    'permdock.m.gen',
    (coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0')::int + 1)::text,
    true
  )
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_bump_memo_generation()
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select set_config(
    'permdock.m.gen',
    (coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0')::int + 1)::text,
    true
  )
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_memo_generation()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform "permdock".permdock_bump_memo_generation();
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
  v_user text := (select "permdock".permdock_user_id())::text;
  v_key text := 'permdock.m.' || 'customer' || '.k' || (hashtext(p_grant) & 1023)::text;
  v_disc text := md5(concat_ws('|',
      v_user,
      p_grant,
      coalesce((select auth.jwt()) ->> 'authz_ver', ''),
      coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
      statement_timestamp()::text,
      md5(coalesce((select auth.jwt())::text, ''))
    ));
  v_memo text := nullif(current_setting(v_key, true), '');
  v_ids uuid[];
begin
  if v_memo is not null and (v_memo::jsonb ->> 'k') = v_disc then
    v_ids := array(select jsonb_array_elements_text(v_memo::jsonb -> 'ids')::uuid);
  else
    v_ids := array(
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
    ))
    );
    perform set_config(v_key, jsonb_build_object('k', v_disc, 'ids', to_jsonb(v_ids))::text, true);
  end if;
  return query select unnest(v_ids);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
  v_user text := (select "permdock".permdock_user_id())::text;
  v_key text := 'permdock.m.' || 'organization' || '.k' || (hashtext(p_grant) & 1023)::text;
  v_disc text := md5(concat_ws('|',
      v_user,
      p_grant,
      coalesce((select auth.jwt()) ->> 'authz_ver', ''),
      coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
      statement_timestamp()::text,
      md5(coalesce((select auth.jwt())::text, ''))
    ));
  v_memo text := nullif(current_setting(v_key, true), '');
  v_ids uuid[];
begin
  if v_memo is not null and (v_memo::jsonb ->> 'k') = v_disc then
    v_ids := array(select jsonb_array_elements_text(v_memo::jsonb -> 'ids')::uuid);
  else
    v_ids := array(
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
    ))
    );
    perform set_config(v_key, jsonb_build_object('k', v_disc, 'ids', to_jsonb(v_ids))::text, true);
  end if;
  return query select unnest(v_ids);
end;
$function$;

CREATE TRIGGER permdock_memo_generation
  AFTER INSERT OR DELETE OR UPDATE ON permdock.custom_role_includes
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation
  AFTER INSERT OR DELETE OR UPDATE ON permdock.custom_role_permissions
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation
  AFTER INSERT OR DELETE OR UPDATE ON permdock.role_permissions
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation
  AFTER INSERT OR DELETE OR UPDATE OF key, organization_id ON public.roles
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation_truncate
  AFTER TRUNCATE ON permdock.custom_role_includes
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation_truncate
  AFTER TRUNCATE ON permdock.custom_role_permissions
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation_truncate
  AFTER TRUNCATE ON permdock.role_permissions
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation_truncate
  AFTER TRUNCATE ON public.roles
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

REVOKE ALL ON FUNCTION "permdock"."permdock_bump_memo_generation"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_memo_generation"() FROM PUBLIC;
