-- the membership entries of one tenant that subject_for(p_user, p_tenant) reads; no client role may execute it
create or replace function "permdock".memberships_for(p_user uuid, p_tenant text)
returns table (ord integer, entry jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
  ) x
  where x.tenant = p_tenant;
end;
$$;
revoke execute on function "permdock".memberships_for(uuid, text) from public, anon, authenticated;

-- the subject the hook would mint for p_user, with the memberships of p_tenant only, for a backend acting for a stored user; no client role may execute it
create or replace function "permdock".subject_for(p_user uuid, p_tenant uuid)
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
    from "permdock".memberships_for(uid, p_tenant::text) x;
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
revoke execute on function "permdock".subject_for(uuid, uuid) from public, anon, authenticated;

