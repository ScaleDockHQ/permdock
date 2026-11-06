SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION permdock.can_quotes (
  p_row        public.quotes,
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
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

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_guard (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else c.tenant_id is not distinct from p_tenant end and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else c.tenant_id is not distinct from p_tenant end and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond(p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      message = 'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out',
      hint = 'not-assignable-by';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_guard_for (
  p_user     uuid,
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else c.tenant_id is not distinct from p_tenant end and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else c.tenant_id is not distinct from p_tenant end and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond_for(p_user, p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      message = 'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out',
      hint = 'not-assignable-by';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_match (
  p_row        public.quotes,
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  with permdock_candidates as (select (p_row).*)
  select exists (select 1 from permdock_candidates where case p_permission
    when 'quotes.list' then coalesce((("organization_id" in (select e::uuid from jsonb_array_elements_text(case when (nullif(current_setting('permdock.m.' || 'organization' || '.k' || (hashtext('quotes.list') & 1023)::text, true), '')::jsonb ->> 'k') = md5(concat_ws('|',
      (select "permdock".permdock_user_id())::text,
      'quotes.list',
      coalesce((select auth.jwt()) ->> 'authz_ver', ''),
      coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
      statement_timestamp()::text,
      md5(coalesce((select auth.jwt())::text, ''))
    )) then nullif(current_setting('permdock.m.' || 'organization' || '.k' || (hashtext('quotes.list') & 1023)::text, true), '')::jsonb -> 'ids' else to_jsonb(array(select * from "permdock".permitted_organization_ids('quotes.list'))) end) s(e))) or ("customer_id" in (select e::uuid from jsonb_array_elements_text(case when (nullif(current_setting('permdock.m.' || 'customer' || '.k' || (hashtext('quotes.list') & 1023)::text, true), '')::jsonb ->> 'k') = md5(concat_ws('|',
      (select "permdock".permdock_user_id())::text,
      'quotes.list',
      coalesce((select auth.jwt()) ->> 'authz_ver', ''),
      coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
      statement_timestamp()::text,
      md5(coalesce((select auth.jwt())::text, ''))
    )) then nullif(current_setting('permdock.m.' || 'customer' || '.k' || (hashtext('quotes.list') & 1023)::text, true), '')::jsonb -> 'ids' else to_jsonb(array(select * from "permdock".permitted_customer_ids('quotes.list'))) end) s(e)))), false)
    when 'quotes.read' then coalesce((("organization_id" in (select e::uuid from jsonb_array_elements_text(case when (nullif(current_setting('permdock.m.' || 'organization' || '.k' || (hashtext('quotes.read') & 1023)::text, true), '')::jsonb ->> 'k') = md5(concat_ws('|',
      (select "permdock".permdock_user_id())::text,
      'quotes.read',
      coalesce((select auth.jwt()) ->> 'authz_ver', ''),
      coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
      statement_timestamp()::text,
      md5(coalesce((select auth.jwt())::text, ''))
    )) then nullif(current_setting('permdock.m.' || 'organization' || '.k' || (hashtext('quotes.read') & 1023)::text, true), '')::jsonb -> 'ids' else to_jsonb(array(select * from "permdock".permitted_organization_ids('quotes.read'))) end) s(e))) or ("customer_id" in (select e::uuid from jsonb_array_elements_text(case when (nullif(current_setting('permdock.m.' || 'customer' || '.k' || (hashtext('quotes.read') & 1023)::text, true), '')::jsonb ->> 'k') = md5(concat_ws('|',
      (select "permdock".permdock_user_id())::text,
      'quotes.read',
      coalesce((select auth.jwt()) ->> 'authz_ver', ''),
      coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
      statement_timestamp()::text,
      md5(coalesce((select auth.jwt())::text, ''))
    )) then nullif(current_setting('permdock.m.' || 'customer' || '.k' || (hashtext('quotes.read') & 1023)::text, true), '')::jsonb -> 'ids' else to_jsonb(array(select * from "permdock".permitted_customer_ids('quotes.read'))) end) s(e)))), false)
    when 'quotes.update' then coalesce(("organization_id" in (select e::uuid from jsonb_array_elements_text(case when (nullif(current_setting('permdock.m.' || 'organization' || '.k' || (hashtext('quotes.update') & 1023)::text, true), '')::jsonb ->> 'k') = md5(concat_ws('|',
      (select "permdock".permdock_user_id())::text,
      'quotes.update',
      coalesce((select auth.jwt()) ->> 'authz_ver', ''),
      coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
      statement_timestamp()::text,
      md5(coalesce((select auth.jwt())::text, ''))
    )) then nullif(current_setting('permdock.m.' || 'organization' || '.k' || (hashtext('quotes.update') & 1023)::text, true), '')::jsonb -> 'ids' else to_jsonb(array(select * from "permdock".permitted_organization_ids('quotes.update'))) end) s(e))), false)
    else false
  end)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_rows (
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select "id"::uuid from "public"."quotes" as permdock_row
  where "permdock".permitted_quotes_match(permdock_row, p_permission)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_rows (
  p_permission text,
  p_ids        uuid[]
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
declare
  v_row "public"."quotes";
  v_rows "public"."quotes"[] := '{}';
  v_id uuid;
begin
  begin
    foreach v_id in array coalesce(p_ids, '{}') loop
      v_row."id" := v_id;
      v_rows := pg_catalog.array_append(v_rows, v_row);
    end loop;
  exception when data_exception then
    v_rows := '{}';
    foreach v_id in array p_ids loop
      begin
        v_row."id" := v_id;
        v_rows := pg_catalog.array_append(v_rows, v_row);
      exception when data_exception then
        null;
      end;
    end loop;
  end;
  return query
  with permdock_candidates as materialized (
    select * from "public"."quotes" where "id" = any (array(select (r)."id" from pg_catalog.unnest(v_rows) r))
  )
  select "id"::uuid from permdock_candidates
  where "permdock".permitted_quotes_match(permdock_candidates, p_permission);
end
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_rows_for (
  p_user       uuid,
  p_permission text,
  p_claims     jsonb DEFAULT '{}'::jsonb
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_claims text := pg_catalog.current_setting('request.jwt.claims', true);
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    (coalesce(p_claims, '{}'::jsonb) || pg_catalog.jsonb_build_object('sub', p_user::text, 'role', 'authenticated'))::text,
    true
  );
  return query select r.id from "permdock".permitted_quotes_rows(p_permission) r(id);
  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_rows_for (
  p_user       uuid,
  p_permission text,
  p_ids        uuid[],
  p_claims     jsonb  DEFAULT '{}'::jsonb
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_claims text := pg_catalog.current_setting('request.jwt.claims', true);
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    (coalesce(p_claims, '{}'::jsonb) || pg_catalog.jsonb_build_object('sub', p_user::text, 'role', 'authenticated'))::text,
    true
  );
  return query select r.id from "permdock".permitted_quotes_rows(p_permission, p_ids) r(id);
  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end
$function$;

REVOKE ALL ON FUNCTION "permdock"."can_quotes"(public.quotes, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."can_quotes"(public.quotes, text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."can_quotes"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."can_quotes"(uuid, text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_quotes_match"(public.quotes, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_quotes_match"(public.quotes, text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_quotes_rows"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_quotes_rows"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_quotes_rows"(text, uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_quotes_rows"(text, uuid[]) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_quotes_rows_for"(uuid, text, jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_quotes_rows_for"(uuid, text, uuid[], jsonb) FROM PUBLIC;
