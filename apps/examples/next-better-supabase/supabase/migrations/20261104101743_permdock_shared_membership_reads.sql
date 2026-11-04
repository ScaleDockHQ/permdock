SET local check_function_bodies = off;

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
  item record;
  extra jsonb;
  ver bigint;
begin
  claims := claims - 'attrs' - 'datetime_preferences' - 'features';
  held := "permdock".global_roles_for(uid);
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := claims -> 'app_metadata' ->> 'tenant_id';
  for item in
    select x.entry, x.root_id is not distinct from active as current
    from (
      select e.ord, e.entry, case when e.entry ->> 'scope' = 'organization' then e.entry ->> 'id' else e.entry -> 'within' ->> 'organization' end as root_id
      from "permdock".membership_entries_for(uid) e
    ) x
    order by (x.root_id is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
  loop
    if octet_length((kept || jsonb_build_array(item.entry))::text) + used > budget then
      truncated := true;
      exit;
    end if;
    kept := kept || jsonb_build_array(item.entry);
    in_active := in_active or (active is not null and item.current);
  end loop;
  claims := jsonb_set(claims, '{memberships}', kept);
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));
  end if;
  extra := "public"."datetime_preference_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{datetime_preferences}', extra);
  end if;
  extra := "public"."feature_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{features}', extra);
  end if;
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(coalesce(ver, 0)));
  return jsonb_set(event, '{claims}', claims);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.global_roles_for (
  p_user uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_roles_user "permdock"."user_roles"."user_id"%type := p_user;
  held jsonb;
begin
  select coalesce(jsonb_agg(distinct r."role"::text order by r."role"::text) filter (where r."role"::text is not null), '[]'::jsonb)
    into held
    from "permdock"."user_roles" r
    where r."user_id" = v_roles_user;
  return held;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.membership_entries_for (
  p_user uuid
)
  RETURNS TABLE (
    ord   integer,
    entry jsonb
  )
  LANGUAGE plpgsql
  STABLE
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
  ) x;
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
    from "permdock".membership_entries_for(uid) x;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'name', c.role,
      'shared', case when c.tenant_id is null and c.scope <> 'global' then true end,
      'tenant', c.tenant_id::text,
      'scope', c.scope,
      'id', c.scope_id,
      'grants', (
        select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'permission', p.permission,
            'effect', p.effect,
            'level', to_jsonb(p) ->> 'level'
          )) order by p.permission, p.effect), '[]'::jsonb)
        from "permdock".custom_role_permissions p
        where p.tenant_id is not distinct from c.tenant_id and p.scope = c.scope and p.scope_id is not distinct from c.scope_id and p.role = c.role
      ),
      'includes', (
        select jsonb_agg(p.include_role order by p.include_role)
        from "permdock".custom_role_includes p
        where p.tenant_id is not distinct from c.tenant_id and p.scope = c.scope and p.scope_id is not distinct from c.scope_id and p.role = c.role
      )
    )) order by c.tenant_id::text, c.scope, c.scope_id, c.role), '[]'::jsonb)
    into custom
    from (
      select tenant_id, scope, scope_id, role from "permdock".custom_role_permissions
      union
      select tenant_id, scope, scope_id, role from "permdock".custom_role_includes
    ) c
    where (c.scope = 'global' and c.tenant_id is null and held ? c.role)
      or exists (
        select 1
        from jsonb_array_elements(memberships) m
        where m -> 'roles' ? c.role
          and m ->> 'scope' = c.scope
          and (
            (c.tenant_id is null and c.scope_id is null)
            or c.tenant_id::text = case when m ->> 'scope' = 'organization' then m ->> 'id' else m -> 'within' ->> 'organization' end
          )
          and (c.scope_id is null or c.scope_id = m ->> 'id')
      );
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
    'authzVersion', ver
  ));
end;
$function$;

REVOKE ALL ON FUNCTION "permdock"."global_roles_for"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."global_roles_for"(uuid) TO "supabase_auth_admin";

REVOKE ALL ON FUNCTION "permdock"."membership_entries_for"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."membership_entries_for"(uuid) TO "supabase_auth_admin";

