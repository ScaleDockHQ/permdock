-- better-supabase module: sso
-- @bsb-block sso@2 managed
-- @bsb-hash sha256:0328a4bd87dafdf4ec2dff7b3331df78e7a32549d7f0ad619a1277d05af8573b
-- Verified email domains with auto-join and SSO enforcement, SAML providers per organization registered with Supabase Auth, and SCIM 2.0 users and groups that provision memberships and map groups to roles.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

grant usage on schema better_supabase to supabase_auth_admin;

-- Email domains an organization claims. A domain is verified once a DNS TXT
-- record _better-supabase.<domain> holds its token; one organization holds each
-- verified domain.
create table "better_supabase"."sso_domains" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "domain" text not null constraint bsb_sso_domains_domain_check check ("domain" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$'),
  "verification_token" text not null default replace(gen_random_uuid()::text, '-', ''),
  "verified_at" timestamptz,
  "auto_join_role" text constraint bsb_sso_domains_auto_join_role_check check ("auto_join_role" = any (array['admin', 'member']::text[])),
  "enforce_sso" boolean not null default false,
  "created_by" uuid references auth.users (id) on delete set null default auth.uid(),
  "created_at" timestamptz not null default now(),
  unique ("tenant_id", "domain"),
  constraint bsb_sso_domains_check check (not "enforce_sso" or "verified_at" is not null)
);
create unique index "sso_domains_verified_idx" on "better_supabase"."sso_domains" ("domain") where "verified_at" is not null;
create index "sso_domains_created_by_idx" on "better_supabase"."sso_domains" ("created_by") where "created_by" is not null;
alter table "better_supabase"."sso_domains" enable row level security;
revoke all on "better_supabase"."sso_domains" from public, anon, authenticated;
grant all on "better_supabase"."sso_domains" to service_role;

-- SAML identity providers registered with Supabase Auth for an organization.
create table "better_supabase"."sso_providers" (
  "id" uuid primary key,
  "tenant_id" uuid not null,
  "type" text not null default 'saml' constraint bsb_sso_providers_type_check check ("type" = 'saml'),
  "metadata_url" text,
  "domains" text[] not null default '{}',
  "created_at" timestamptz not null default now()
);
create index "sso_providers_tenant_idx" on "better_supabase"."sso_providers" ("tenant_id");
alter table "better_supabase"."sso_providers" enable row level security;
revoke all on "better_supabase"."sso_providers" from public, anon, authenticated;
grant all on "better_supabase"."sso_providers" to service_role;

-- SCIM 2.0 users and groups per organization, written by the SCIM handler.
-- A user links to an account whose confirmed email is at a verified domain
-- of the organization; groups map to roles.
create table "better_supabase"."scim_users" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "user_id" uuid references auth.users (id) on delete set null,
  "external_id" text,
  "user_name" text not null constraint bsb_scim_users_user_name_check check (length("user_name") >= 1 and length("user_name") <= 320),
  "display_name" text,
  "given_name" text,
  "family_name" text,
  "email" text,
  "emails" jsonb not null default '[]'::jsonb constraint bsb_scim_users_emails_check check (jsonb_typeof("emails") = 'array'),
  "active" boolean not null default true,
  "version" integer not null default 1,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create unique index scim_users_user_name_idx on "better_supabase"."scim_users" ("tenant_id", lower("user_name"));
create unique index scim_users_external_id_idx on "better_supabase"."scim_users" ("tenant_id", "external_id") where "external_id" is not null;
create unique index scim_users_user_idx on "better_supabase"."scim_users" ("tenant_id", "user_id") where "user_id" is not null;
create index scim_users_email_idx on "better_supabase"."scim_users" ("email") where "user_id" is null;
create index scim_users_account_idx on "better_supabase"."scim_users" ("user_id") where "user_id" is not null;
alter table "better_supabase"."scim_users" enable row level security;
revoke all on "better_supabase"."scim_users" from public, anon, authenticated;
grant all on "better_supabase"."scim_users" to service_role;

create table "better_supabase"."scim_groups" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "display_name" text not null constraint bsb_scim_groups_display_name_check check (length("display_name") >= 1 and length("display_name") <= 256),
  "external_id" text,
  "role" text,
  "version" integer not null default 1,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create unique index scim_groups_display_name_idx on "better_supabase"."scim_groups" ("tenant_id", lower("display_name"));
create unique index scim_groups_external_id_idx on "better_supabase"."scim_groups" ("tenant_id", "external_id") where "external_id" is not null;
alter table "better_supabase"."scim_groups" enable row level security;
revoke all on "better_supabase"."scim_groups" from public, anon, authenticated;
grant all on "better_supabase"."scim_groups" to service_role;

create table "better_supabase"."scim_group_members" (
  "group_id" uuid not null references "better_supabase"."scim_groups" ("id") on delete cascade,
  "scim_user_id" uuid not null references "better_supabase"."scim_users" ("id") on delete cascade,
  primary key ("group_id", "scim_user_id")
);
create index scim_group_members_member_idx on "better_supabase"."scim_group_members" ("scim_user_id");
alter table "better_supabase"."scim_group_members" enable row level security;
revoke all on "better_supabase"."scim_group_members" from public, anon, authenticated;
grant all on "better_supabase"."scim_group_members" to service_role;

-- The role a SCIM group grants: groupRoles by name, else a group named
-- like an assignable role, else none.
create or replace function "better_supabase"."scim_group_role"(display_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select t.role from (select null::text as name, null::text as role where false) as t(name, role) where t.name = lower(scim_group_role.display_name)),
    case when lower(scim_group_role.display_name) = any (array['admin', 'member']::text[]) then lower(scim_group_role.display_name) end
  )
$$;

-- Brings one SCIM user's membership in line: removed when inactive, else
-- the highest role of its groups (roleOrder) or defaultRole. Owners are
-- never changed.
create or replace function "better_supabase"."scim_sync_member"(scim_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."scim_users";
  v_tenant uuid;
  v_user uuid;
  v_current text;
  v_role text;
begin
  select * into v_row from "better_supabase"."scim_users" x where x."id" = scim_sync_member.scim_user;
  if v_row."user_id" is null then
    return;
  end if;
  v_tenant := v_row."tenant_id";
  v_user := v_row."user_id";
  select mm."role" into v_current from "public"."organization_memberships" mm where mm."organization_id" = v_tenant and mm."user_id" = v_user;
  if v_current = 'owner' then
    return;
  end if;
  if not v_row."active" then
    delete from "public"."organization_memberships" mm where mm."organization_id" = v_tenant and mm."user_id" = v_user;
    if found then
      perform better_supabase.audit_event(
    event_type => 'organization.member_removed',
    category => 'membership',
    target_type => 'user',
    record_id => v_user::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant::text, 'userId', v_user)
  );
    end if;
    return;
  end if;
  select coalesce((
    select sg."role" from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" sg on sg."id" = sm."group_id"
    where sm."scim_user_id" = v_row."id" and sg."role" is not null
    order by array_position(array['admin', 'member']::text[], sg."role")
    limit 1
  ), 'member') into v_role;
  if v_current is null then
    insert into "public"."organization_memberships" ("organization_id", "user_id", "role") values (v_tenant, v_user, v_role);
    perform better_supabase.audit_event(
    event_type => 'organization.member_added',
    category => 'membership',
    target_type => 'user',
    record_id => v_user::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant::text, 'userId', v_user, 'role', v_role)
  );
  elsif v_current is distinct from v_role then
    update "public"."organization_memberships" mm set "role" = v_role where mm."organization_id" = v_tenant and mm."user_id" = v_user;
    perform better_supabase.audit_event(
    event_type => 'organization.role_changed',
    category => 'membership',
    target_type => 'user',
    record_id => v_user::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant::text, 'userId', v_user, 'role', v_role, 'previousRole', v_current)
  );
  end if;
end;
$$;

-- Claims a domain for the organization (needs the manage permission).
-- Returns it with the TXT record to publish; adding it again returns it.
create or replace function "better_supabase"."create_organization_domain"(tenant uuid, domain text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row "better_supabase"."sso_domains";
  v_domain text := lower(trim(trailing '.' from trim(create_organization_domain.domain)));
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not coalesce(better_supabase.can('tenant', create_organization_domain.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s domains' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_domain !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$' then
    raise exception 'Not a domain name: %', create_organization_domain.domain using errcode = '22023', hint = 'SSO_DOMAIN_INVALID';
  end if;
  insert into "better_supabase"."sso_domains" as x ("tenant_id", "domain") values (create_organization_domain.tenant, v_domain)
  on conflict ("tenant_id", "domain") do update set "domain" = x."domain"
  returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'sso_domain.created',
    category => 'security',
    target_type => 'domain',
    record_id => v_row."id"::text,
    target_label => v_row."domain",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'domainId', v_row."id", 'domain', v_row."domain", 'userId', auth.uid()),
    actor_id => auth.uid()
  );
  return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
end;
$$;

create or replace function "better_supabase"."list_organization_domains"(tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.can('tenant', list_organization_domains.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s domains' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) order by x."domain"), '[]'::jsonb)
    from "better_supabase"."sso_domains" x where x."tenant_id" = list_organization_domains.tenant
  );
end;
$$;

-- An organization's claimed domains as a keyset page, with the record to publish (ADR 1077). filters is { verified, enforceSso, autoJoinRole (each a value or a list), search, sort (domain, verifiedAt), direction, facet, count, limit, after, offset, paged, total, totalCap }.
create or replace function "better_supabase"."page_organization_domains"(tenant uuid, filters jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_organization_domains.filters, '{}'::jsonb);
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
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.can('tenant', page_organization_domains.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s domains' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('verified', 'enforceSso') then
      raise exception 'facet is one of verified, enforceSso' using errcode = '22023', hint = 'SSO_INVALID';
    end if;
    with s as (
      select (case v_facet when 'verified' then ((x."verified_at" is not null)::text)::text when 'enforceSso' then (x."enforce_sso"::text)::text end) as v
      from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
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
      select 1 from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('domain', 'verifiedAt') then
    raise exception 'sort is one of domain, verifiedAt' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."domain")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."domain", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."domain" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."domain")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."domain" <= (v_after ->> 0)::text and ((x."domain" < (v_after ->> 0)::text) or (x."domain" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."domain" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'domain' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."domain")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."domain", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."domain" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'domain' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."domain")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."domain" <= (v_after ->> 0)::text and ((x."domain" < (v_after ->> 0)::text) or (x."domain" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."domain" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'verifiedAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."verified_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."verified_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."verified_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'verifiedAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."verified_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."verified_at" <= (v_after ->> 0)::timestamptz and ((x."verified_at" < (v_after ->> 0)::timestamptz) or (x."verified_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."verified_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$$;

-- One domain with its record, for the service role or a manager.
create or replace function "better_supabase"."organization_domain"(id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."sso_domains";
begin
  select * into v_row from "better_supabase"."sso_domains" x where x."id" = organization_domain.id;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'sso.manage'), false)) then
    return null;
  end if;
  return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
end;
$$;

-- Auto-join role and SSO enforcement for a domain; enforcing needs it verified.
create or replace function "better_supabase"."update_organization_domain"(id uuid, auto_join_role text default null, enforce_sso boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."sso_domains";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."sso_domains" x where x."id" = update_organization_domain.id for update;
  if v_row."id" is null or not coalesce(better_supabase.can('tenant', v_row."tenant_id", 'sso.manage'), false) then
    raise exception 'No domain you manage has this id' using errcode = 'P0002', hint = 'SSO_DOMAIN_NOT_FOUND';
  end if;
  if update_organization_domain.auto_join_role is not null and not (update_organization_domain.auto_join_role = any (array['admin', 'member']::text[])) then
    raise exception 'Auto-join cannot assign role %', update_organization_domain.auto_join_role using errcode = '22023', hint = 'SSO_ROLE_INVALID';
  end if;
  if update_organization_domain.auto_join_role is not null
    and not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin'))
    and not coalesce(better_supabase.can_assign(v_row."tenant_id", update_organization_domain.auto_join_role), false) then
    raise exception 'You may not assign role %', update_organization_domain.auto_join_role using errcode = '42501', hint = 'SSO_ROLE_FORBIDDEN';
  end if;
  if (update_organization_domain.enforce_sso or update_organization_domain.auto_join_role is not null) and v_row."verified_at" is null then
    raise exception 'Verify the domain first' using errcode = '22023', hint = 'SSO_DOMAIN_NOT_VERIFIED';
  end if;
  update "better_supabase"."sso_domains" x set "auto_join_role" = update_organization_domain.auto_join_role, "enforce_sso" = update_organization_domain.enforce_sso
  where x."id" = v_row."id"
  returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'sso_domain.updated',
    category => 'security',
    target_type => 'domain',
    record_id => v_row."id"::text,
    target_label => v_row."domain",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'domainId', v_row."id", 'domain', v_row."domain", 'userId', auth.uid()),
    actor_id => auth.uid()
  );
  return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
end;
$$;

create or replace function "better_supabase"."delete_organization_domain"(id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."sso_domains";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."sso_domains" x where x."id" = delete_organization_domain.id;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'sso.manage'), false)) then
    return false;
  end if;
  if exists (select 1 from "better_supabase"."sso_providers" sp where sp."tenant_id" = v_row."tenant_id" and v_row."domain" = any (sp."domains")) then
    raise exception 'An SSO provider uses this domain; remove it first' using errcode = '23503', hint = 'SSO_DOMAIN_IN_USE';
  end if;
  delete from "better_supabase"."sso_domains" x where x."id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'sso_domain.deleted',
    category => 'security',
    target_type => 'domain',
    record_id => v_row."id"::text,
    target_label => v_row."domain",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'domainId', v_row."id", 'domain', v_row."domain", 'userId', auth.uid()),
    actor_id => auth.uid()
  );
  return true;
end;
$$;

-- Marks a domain verified once the app has found its TXT record (service
-- role). `actor`, when set, must hold the manage permission.
create or replace function "better_supabase"."verify_organization_domain"(id uuid, actor uuid default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row "better_supabase"."sso_domains";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role verifies domains' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."sso_domains" x where x."id" = verify_organization_domain.id for update;
  if v_row."id" is null or not (verify_organization_domain.actor is null or coalesce(better_supabase.can_user(verify_organization_domain.actor, 'tenant', v_row."tenant_id", 'sso.manage'), false)) then
    raise exception 'No domain you manage has this id' using errcode = 'P0002', hint = 'SSO_DOMAIN_NOT_FOUND';
  end if;
  if v_row."verified_at" is not null then
    return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
  end if;
  if exists (select 1 from "better_supabase"."sso_domains" x where x."domain" = v_row."domain" and x."verified_at" is not null) then
    raise exception 'Another organization has verified %', v_row."domain" using errcode = '23505', hint = 'SSO_DOMAIN_TAKEN';
  end if;
  update "better_supabase"."sso_domains" x set "verified_at" = now() where x."id" = v_row."id" returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'sso_domain.verified',
    category => 'security',
    target_type => 'domain',
    record_id => v_row."id"::text,
    target_label => v_row."domain",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'domainId', v_row."id", 'domain', v_row."domain", 'userId', verify_organization_domain.actor),
    actor_id => verify_organization_domain.actor
  );
  return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
end;
$$;

-- Checks that `actor` may register a provider for these domains: all
-- verified and owned by the tenant (service role).
create or replace function "better_supabase"."check_sso_provider"(tenant uuid, domains text[], actor uuid default null)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role registers SSO providers' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if not (check_sso_provider.actor is null or coalesce(better_supabase.can_user(check_sso_provider.actor, 'tenant', check_sso_provider.tenant, 'sso.manage'), false)) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if cardinality(check_sso_provider.domains) = 0 or exists (
    select 1 from unnest(check_sso_provider.domains) as w(domain)
    where not exists (
      select 1 from "better_supabase"."sso_domains" x where x."tenant_id" = check_sso_provider.tenant and x."domain" = lower(w.domain) and x."verified_at" is not null
    )
  ) then
    raise exception 'Every SSO domain must be a verified domain of the organization' using errcode = '22023', hint = 'SSO_DOMAIN_NOT_VERIFIED';
  end if;
end;
$$;

-- Records a provider created in Supabase Auth (service role).
create or replace function "better_supabase"."register_sso_provider"(tenant uuid, provider uuid, domains text[], metadata_url text default null, actor uuid default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row "better_supabase"."sso_providers";
begin
  perform "better_supabase"."check_sso_provider"(register_sso_provider.tenant, register_sso_provider.domains, register_sso_provider.actor);
  insert into "better_supabase"."sso_providers" as x ("id", "tenant_id", "metadata_url", "domains")
  values (register_sso_provider.provider, register_sso_provider.tenant, register_sso_provider.metadata_url,
    (select array_agg(distinct lower(w.domain) order by lower(w.domain)) from unnest(register_sso_provider.domains) as w(domain)))
  on conflict ("id") do update set "metadata_url" = excluded."metadata_url", "domains" = excluded."domains"
  where x."tenant_id" = excluded."tenant_id"
  returning * into v_row;
  if v_row."id" is null then
    raise exception 'The provider belongs to another organization' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  perform better_supabase.audit_event(
    event_type => 'sso_provider.registered',
    category => 'security',
    target_type => 'sso_provider',
    record_id => v_row."id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'providerId', v_row."id", 'domains', to_jsonb(v_row."domains"), 'userId', register_sso_provider.actor),
    actor_id => register_sso_provider.actor
  );
  return to_jsonb(v_row);
end;
$$;

-- One provider (service role), or null; `actor`, when set, must hold the
-- manage permission in its organization.
create or replace function "better_supabase"."sso_provider"(provider uuid, actor uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_row "better_supabase"."sso_providers";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role registers SSO providers' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."sso_providers" x where x."id" = sso_provider.provider;
  if v_row."id" is null then
    return null;
  end if;
  if not (sso_provider.actor is null or coalesce(better_supabase.can_user(sso_provider.actor, 'tenant', v_row."tenant_id", 'sso.manage'), false)) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return to_jsonb(v_row);
end;
$$;

-- Forgets a provider (service role). Returns it, or null.
create or replace function "better_supabase"."unregister_sso_provider"(provider uuid, actor uuid default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row "better_supabase"."sso_providers";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role registers SSO providers' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."sso_providers" x where x."id" = unregister_sso_provider.provider;
  if v_row."id" is null then
    return null;
  end if;
  if not (unregister_sso_provider.actor is null or coalesce(better_supabase.can_user(unregister_sso_provider.actor, 'tenant', v_row."tenant_id", 'sso.manage'), false)) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  delete from "better_supabase"."sso_providers" x where x."id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'sso_provider.unregistered',
    category => 'security',
    target_type => 'sso_provider',
    record_id => v_row."id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'providerId', v_row."id", 'domains', to_jsonb(v_row."domains"), 'userId', unregister_sso_provider.actor),
    actor_id => unregister_sso_provider.actor
  );
  return to_jsonb(v_row);
end;
$$;

create or replace function "better_supabase"."list_sso_providers"(tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.can('tenant', list_sso_providers.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(x.*) order by x."created_at"), '[]'::jsonb)
    from "better_supabase"."sso_providers" x where x."tenant_id" = list_sso_providers.tenant
  );
end;
$$;

-- An organization's SSO providers as a keyset page, oldest first (ADR 1077). filters is { type (a value or a list), sort (createdAt), direction, facet, count, limit, after, offset, paged, total, totalCap }.
create or replace function "better_supabase"."page_sso_providers"(tenant uuid, filters jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_sso_providers.filters, '{}'::jsonb);
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
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.can('tenant', page_sso_providers.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('type') then
      raise exception 'facet is one of type' using errcode = '22023', hint = 'SSO_INVALID';
    end if;
    with s as (
      select (case v_facet when 'type' then (x."type"::text)::text end) as v
      from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
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
      select 1 from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('createdAt') then
    raise exception 'sort is one of createdAt' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x.*) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x.*) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x.*) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x.*) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
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
      select 1 from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$$;

-- The SSO provider for an email address, for the sign-in page: null unless
-- its domain is verified and has a provider.
create or replace function "better_supabase"."sso_domain_for"(email text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'domain', x."domain",
    'organizationId', x."tenant_id"::text,
    'providerId', sp."id",
    'enforceSso', x."enforce_sso"
  )
  from "better_supabase"."sso_domains" x
  join "better_supabase"."sso_providers" sp on sp."tenant_id" = x."tenant_id" and x."domain" = any (sp."domains")
  where x."verified_at" is not null
    and x."domain" = lower(split_part(sso_domain_for.email, '@', 2))
  limit 1
$$;

-- Call from the custom access token hook. Returns the event unchanged, or
-- an error when the user's email domain enforces SSO and the session did
-- not sign in with SAML:
--   result := better_supabase.sso_access_token_check(event);
--   if result ? 'error' then return result; end if;
create or replace function "better_supabase"."sso_access_token_check"(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select au.email into v_email from auth.users au where au.id = (sso_access_token_check.event ->> 'user_id')::uuid;
  if v_email is null or not exists (
    select 1 from "better_supabase"."sso_domains" x
    where x."verified_at" is not null and x."enforce_sso" and x."domain" = lower(split_part(v_email, '@', 2))
  ) then
    return sso_access_token_check.event;
  end if;
  if sso_access_token_check.event ->> 'authentication_method' = 'sso/saml'
    or exists (
      select 1 from jsonb_array_elements(coalesce(sso_access_token_check.event -> 'claims' -> 'amr', '[]'::jsonb)) a(entry)
      where a.entry ->> 'method' = 'sso/saml'
    ) then
    return sso_access_token_check.event;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Sign in with your organization''s single sign-on'
  ));
end;
$$;

-- On a confirmed email: links waiting SCIM users of organizations that
-- verified the domain, then adds the user to organizations whose domain
-- auto-joins. A failure warns instead of aborting the sign-up.
create or replace function "better_supabase"."sso_on_auth_user"()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scim record;
  v_join record;
  v_tenant uuid;
  v_user uuid := new.id;
begin
  if new.email is null or new.email_confirmed_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.email is not distinct from new.email and old.email_confirmed_at is not null then
    return new;
  end if;
  begin
    for v_scim in
      update "better_supabase"."scim_users" x set "user_id" = new.id
      where x."user_id" is null and x."email" = lower(new.email)
        and exists (select 1 from "better_supabase"."sso_domains" vd where vd."tenant_id" = x."tenant_id" and vd."verified_at" is not null and vd."domain" = lower(split_part(new.email, '@', 2)))
        and not exists (select 1 from "better_supabase"."scim_users" y where y."tenant_id" = x."tenant_id" and y."user_id" = new.id)
      returning x."id" as id
    loop
      perform "better_supabase"."scim_sync_member"(v_scim.id);
    end loop;
    for v_join in
      select x."tenant_id" as tenant, x."auto_join_role" as role from "better_supabase"."sso_domains" x
      where x."verified_at" is not null and x."auto_join_role" is not null
        and x."domain" = lower(split_part(new.email, '@', 2))
        and not exists (select 1 from "better_supabase"."scim_users" y where y."tenant_id" = x."tenant_id" and y."user_id" = new.id)
        and not exists (select 1 from "public"."organization_memberships" mm where mm."organization_id" = x."tenant_id" and mm."user_id" = new.id)
    loop
      v_tenant := v_join.tenant;
      insert into "public"."organization_memberships" ("organization_id", "user_id", "role") values (v_tenant, v_user, v_join.role);
      perform better_supabase.audit_event(
    event_type => 'organization.member_added',
    category => 'membership',
    target_type => 'user',
    record_id => v_user::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant::text, 'userId', v_user, 'role', v_join.role)
  );
    end loop;
  exception when others then
    raise warning 'SSO membership for user % failed: % (SQLSTATE %)', new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
$$;

-- SCIM storage for the SCIM handler (service role). Rows come back as
-- jsonb; users carry their groups and groups their members.
create or replace function "better_supabase"."scim_list_users"(tenant uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(x.*) || jsonb_build_object('groups', (
      select coalesce(jsonb_agg(jsonb_build_object('value', sg."id", 'display', sg."display_name") order by sg."display_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" sg on sg."id" = sm."group_id"
      where sm."scim_user_id" = x."id"
    )) order by x."created_at", x."id"), '[]'::jsonb)
    from "better_supabase"."scim_users" x where x."tenant_id" = scim_list_users.tenant
  );
end;
$$;

create or replace function "better_supabase"."scim_get_user"(tenant uuid, id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select to_jsonb(x.*) || jsonb_build_object('groups', (
      select coalesce(jsonb_agg(jsonb_build_object('value', sg."id", 'display', sg."display_name") order by sg."display_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" sg on sg."id" = sm."group_id"
      where sm."scim_user_id" = x."id"
    )) from "better_supabase"."scim_users" x
    where x."tenant_id" = scim_get_user.tenant and x."id" = scim_get_user.id
  );
end;
$$;

-- Creates (id null) or replaces a SCIM user. `version`, when set, must
-- match (If-Match). data: { userName, externalId, displayName, givenName,
-- familyName, emails, active }.
create or replace function "better_supabase"."scim_save_user"(tenant uuid, id uuid, data jsonb, version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."scim_users";
  v_emails jsonb := coalesce(scim_save_user.data -> 'emails', '[]'::jsonb);
  v_name text := scim_save_user.data ->> 'userName';
  v_email text;
  v_user uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_name is null or length(trim(v_name)) = 0 then
    raise exception 'userName is required' using errcode = '22023', hint = 'SCIM_INVALID';
  end if;
  if jsonb_typeof(v_emails) <> 'array' then
    raise exception 'emails must be an array' using errcode = '22023', hint = 'SCIM_INVALID';
  end if;
  v_email := lower(coalesce(
    (select e ->> 'value' from jsonb_array_elements(v_emails) e where (e ->> 'primary')::boolean limit 1),
    v_emails -> 0 ->> 'value',
    case when v_name like '%@%' then v_name end
  ));
  if scim_save_user.id is null then
    insert into "better_supabase"."scim_users" ("tenant_id", "external_id", "user_name", "display_name", "given_name", "family_name", "email", "emails", "active")
    values (scim_save_user.tenant, scim_save_user.data ->> 'externalId', v_name, scim_save_user.data ->> 'displayName',
      scim_save_user.data ->> 'givenName', scim_save_user.data ->> 'familyName', v_email, v_emails,
      coalesce((scim_save_user.data ->> 'active')::boolean, true))
    returning * into v_row;
  else
    select * into v_row from "better_supabase"."scim_users" x where x."tenant_id" = scim_save_user.tenant and x."id" = scim_save_user.id for update;
    if v_row."id" is null then
      raise exception 'No SCIM user has this id' using errcode = 'P0002', hint = 'SCIM_NOT_FOUND';
    end if;
    if scim_save_user.version is not null and scim_save_user.version <> v_row."version" then
      raise exception 'The user changed since version %', scim_save_user.version using errcode = 'P0001', hint = 'SCIM_PRECONDITION';
    end if;
    update "better_supabase"."scim_users" x set
      "external_id" = scim_save_user.data ->> 'externalId',
      "user_name" = v_name,
      "display_name" = scim_save_user.data ->> 'displayName',
      "given_name" = scim_save_user.data ->> 'givenName',
      "family_name" = scim_save_user.data ->> 'familyName',
      "email" = v_email,
      "emails" = v_emails,
      "active" = coalesce((scim_save_user.data ->> 'active')::boolean, true),
      "version" = x."version" + 1,
      "updated_at" = now()
    where x."id" = v_row."id"
    returning * into v_row;
  end if;
  if v_row."user_id" is null and v_email is not null and exists (select 1 from "better_supabase"."sso_domains" vd where vd."tenant_id" = scim_save_user.tenant and vd."verified_at" is not null and vd."domain" = lower(split_part(v_email, '@', 2))) then
    select au.id into v_user from auth.users au
    where lower(au.email) = v_email and au.email_confirmed_at is not null
      and not exists (select 1 from "better_supabase"."scim_users" y where y."tenant_id" = scim_save_user.tenant and y."user_id" = au.id)
    limit 1;
    if v_user is not null then
      update "better_supabase"."scim_users" x set "user_id" = v_user where x."id" = v_row."id" returning * into v_row;
    end if;
  end if;
  perform "better_supabase"."scim_sync_member"(v_row."id");
  if scim_save_user.id is null then
    perform better_supabase.audit_event(
    event_type => 'scim_user.created',
    category => 'security',
    target_type => 'scim_user',
    record_id => v_row."id"::text,
    tenant => (scim_save_user.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_save_user.tenant::text, 'scimUserId', v_row."id")
  );
  else
    perform better_supabase.audit_event(
    event_type => 'scim_user.updated',
    category => 'security',
    target_type => 'scim_user',
    record_id => v_row."id"::text,
    tenant => (scim_save_user.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_save_user.tenant::text, 'scimUserId', v_row."id")
  );
  end if;
  return (select to_jsonb(x.*) || jsonb_build_object('groups', (
      select coalesce(jsonb_agg(jsonb_build_object('value', sg."id", 'display', sg."display_name") order by sg."display_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" sg on sg."id" = sm."group_id"
      where sm."scim_user_id" = x."id"
    )) from "better_supabase"."scim_users" x where x."id" = v_row."id");
end;
$$;

-- Deprovisions (removes the membership) and deletes a SCIM user.
create or replace function "better_supabase"."scim_delete_user"(tenant uuid, id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  update "better_supabase"."scim_users" x set "active" = false
  where x."tenant_id" = scim_delete_user.tenant and x."id" = scim_delete_user.id
  returning x."id" into v_id;
  if v_id is null then
    return false;
  end if;
  perform "better_supabase"."scim_sync_member"(v_id);
  delete from "better_supabase"."scim_users" x where x."id" = v_id;
  perform better_supabase.audit_event(
    event_type => 'scim_user.deleted',
    category => 'security',
    target_type => 'scim_user',
    record_id => v_id::text,
    tenant => (scim_delete_user.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_delete_user.tenant::text, 'scimUserId', v_id)
  );
  return true;
end;
$$;

create or replace function "better_supabase"."scim_list_groups"(tenant uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(x.*) || jsonb_build_object('members', (
      select coalesce(jsonb_agg(jsonb_build_object('value', su."id", 'display', coalesce(su."display_name", su."user_name")) order by su."user_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_users" su on su."id" = sm."scim_user_id"
      where sm."group_id" = x."id"
    )) order by x."created_at", x."id"), '[]'::jsonb)
    from "better_supabase"."scim_groups" x where x."tenant_id" = scim_list_groups.tenant
  );
end;
$$;

create or replace function "better_supabase"."scim_get_group"(tenant uuid, id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select to_jsonb(x.*) || jsonb_build_object('members', (
      select coalesce(jsonb_agg(jsonb_build_object('value', su."id", 'display', coalesce(su."display_name", su."user_name")) order by su."user_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_users" su on su."id" = sm."scim_user_id"
      where sm."group_id" = x."id"
    )) from "better_supabase"."scim_groups" x
    where x."tenant_id" = scim_get_group.tenant and x."id" = scim_get_group.id
  );
end;
$$;

-- Creates (id null) or replaces a group and its members, then syncs the
-- roles of everyone who joined or left. data: { displayName, externalId,
-- members: [scim user id] }.
create or replace function "better_supabase"."scim_save_group"(tenant uuid, id uuid, data jsonb, version integer default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row "better_supabase"."scim_groups";
  v_name text := scim_save_group.data ->> 'displayName';
  v_members uuid[];
  v_before uuid[] := '{}';
  v_member uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_name is null or length(trim(v_name)) = 0 then
    raise exception 'displayName is required' using errcode = '22023', hint = 'SCIM_INVALID';
  end if;
  begin
    select coalesce(array_agg(distinct (w.value)::uuid), '{}') into v_members
    from jsonb_array_elements_text(coalesce(scim_save_group.data -> 'members', '[]'::jsonb)) w;
  exception when invalid_text_representation then
    raise exception 'members must be SCIM user ids' using errcode = '22023', hint = 'SCIM_INVALID';
  end;
  if exists (
    select 1 from unnest(v_members) w(member)
    where not exists (select 1 from "better_supabase"."scim_users" x where x."tenant_id" = scim_save_group.tenant and x."id" = w.member)
  ) then
    raise exception 'members must be SCIM users of the organization' using errcode = '22023', hint = 'SCIM_INVALID';
  end if;
  if scim_save_group.id is null then
    insert into "better_supabase"."scim_groups" ("tenant_id", "display_name", "external_id", "role")
    values (scim_save_group.tenant, v_name, scim_save_group.data ->> 'externalId', "better_supabase"."scim_group_role"(v_name))
    returning * into v_row;
  else
    select * into v_row from "better_supabase"."scim_groups" x where x."tenant_id" = scim_save_group.tenant and x."id" = scim_save_group.id for update;
    if v_row."id" is null then
      raise exception 'No SCIM group has this id' using errcode = 'P0002', hint = 'SCIM_NOT_FOUND';
    end if;
    if scim_save_group.version is not null and scim_save_group.version <> v_row."version" then
      raise exception 'The group changed since version %', scim_save_group.version using errcode = 'P0001', hint = 'SCIM_PRECONDITION';
    end if;
    select coalesce(array_agg(sm."scim_user_id"), '{}') into v_before from "better_supabase"."scim_group_members" sm where sm."group_id" = v_row."id";
    update "better_supabase"."scim_groups" x set
      "display_name" = v_name,
      "external_id" = scim_save_group.data ->> 'externalId',
      "role" = "better_supabase"."scim_group_role"(v_name),
      "version" = x."version" + 1,
      "updated_at" = now()
    where x."id" = v_row."id"
    returning * into v_row;
    delete from "better_supabase"."scim_group_members" sm where sm."group_id" = v_row."id" and not (sm."scim_user_id" = any (v_members));
  end if;
  insert into "better_supabase"."scim_group_members" ("group_id", "scim_user_id")
  select v_row."id", w.member from unnest(v_members) w(member)
  on conflict do nothing;
  for v_member in select distinct w.member from unnest(v_before || v_members) w(member) loop
    perform "better_supabase"."scim_sync_member"(v_member);
  end loop;
  if scim_save_group.id is null then
    perform better_supabase.audit_event(
    event_type => 'scim_group.created',
    category => 'security',
    target_type => 'scim_group',
    record_id => v_row."id"::text,
    tenant => (scim_save_group.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_save_group.tenant::text, 'scimGroupId', v_row."id")
  );
  else
    perform better_supabase.audit_event(
    event_type => 'scim_group.updated',
    category => 'security',
    target_type => 'scim_group',
    record_id => v_row."id"::text,
    tenant => (scim_save_group.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_save_group.tenant::text, 'scimGroupId', v_row."id")
  );
  end if;
  return (select to_jsonb(x.*) || jsonb_build_object('members', (
      select coalesce(jsonb_agg(jsonb_build_object('value', su."id", 'display', coalesce(su."display_name", su."user_name")) order by su."user_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_users" su on su."id" = sm."scim_user_id"
      where sm."group_id" = x."id"
    )) from "better_supabase"."scim_groups" x where x."id" = v_row."id");
end;
$$;

create or replace function "better_supabase"."scim_delete_group"(tenant uuid, id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_members uuid[];
  v_member uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  select coalesce(array_agg(sm."scim_user_id"), '{}') into v_members
  from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" x on x."id" = sm."group_id"
  where x."tenant_id" = scim_delete_group.tenant and x."id" = scim_delete_group.id;
  delete from "better_supabase"."scim_groups" x where x."tenant_id" = scim_delete_group.tenant and x."id" = scim_delete_group.id;
  if not found then
    return false;
  end if;
  foreach v_member in array v_members loop
    perform "better_supabase"."scim_sync_member"(v_member);
  end loop;
  perform better_supabase.audit_event(
    event_type => 'scim_group.deleted',
    category => 'security',
    target_type => 'scim_group',
    record_id => scim_delete_group.id::text,
    tenant => (scim_delete_group.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_delete_group.tenant::text, 'scimGroupId', scim_delete_group.id)
  );
  return true;
end;
$$;
revoke execute on function "better_supabase"."scim_group_role"(text) from public, anon, authenticated;
revoke execute on function "better_supabase"."scim_sync_member"(uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."sso_on_auth_user"() from public, anon, authenticated;
revoke execute on function "better_supabase"."create_organization_domain"(uuid, text) from public, anon;
revoke execute on function "better_supabase"."list_organization_domains"(uuid) from public, anon;
revoke execute on function "better_supabase"."organization_domain"(uuid) from public, anon;
revoke execute on function "better_supabase"."update_organization_domain"(uuid, text, boolean) from public, anon;
revoke execute on function "better_supabase"."delete_organization_domain"(uuid) from public, anon;
revoke execute on function "better_supabase"."verify_organization_domain"(uuid, uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."check_sso_provider"(uuid, text[], uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."register_sso_provider"(uuid, uuid, text[], text, uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."sso_provider"(uuid, uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."unregister_sso_provider"(uuid, uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."list_sso_providers"(uuid) from public, anon;
revoke execute on function "better_supabase"."page_organization_domains"(uuid, jsonb) from public, anon;
revoke execute on function "better_supabase"."page_sso_providers"(uuid, jsonb) from public, anon;
revoke execute on function "better_supabase"."sso_domain_for"(text) from public;
revoke execute on function "better_supabase"."sso_access_token_check"(jsonb) from public, anon, authenticated;
revoke execute on function "better_supabase"."scim_list_users"(uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."scim_get_user"(uuid, uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."scim_save_user"(uuid, uuid, jsonb, integer) from public, anon, authenticated;
revoke execute on function "better_supabase"."scim_delete_user"(uuid, uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."scim_list_groups"(uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."scim_get_group"(uuid, uuid) from public, anon, authenticated;
revoke execute on function "better_supabase"."scim_save_group"(uuid, uuid, jsonb, integer) from public, anon, authenticated;
revoke execute on function "better_supabase"."scim_delete_group"(uuid, uuid) from public, anon, authenticated;
grant execute on function "better_supabase"."scim_group_role"(text) to service_role;
grant execute on function "better_supabase"."scim_sync_member"(uuid) to service_role;
grant execute on function "better_supabase"."create_organization_domain"(uuid, text) to authenticated, service_role;
grant execute on function "better_supabase"."list_organization_domains"(uuid) to authenticated, service_role;
grant execute on function "better_supabase"."organization_domain"(uuid) to authenticated, service_role;
grant execute on function "better_supabase"."update_organization_domain"(uuid, text, boolean) to authenticated, service_role;
grant execute on function "better_supabase"."delete_organization_domain"(uuid) to authenticated, service_role;
grant execute on function "better_supabase"."verify_organization_domain"(uuid, uuid) to service_role;
grant execute on function "better_supabase"."check_sso_provider"(uuid, text[], uuid) to service_role;
grant execute on function "better_supabase"."register_sso_provider"(uuid, uuid, text[], text, uuid) to service_role;
grant execute on function "better_supabase"."sso_provider"(uuid, uuid) to service_role;
grant execute on function "better_supabase"."unregister_sso_provider"(uuid, uuid) to service_role;
grant execute on function "better_supabase"."list_sso_providers"(uuid) to authenticated, service_role;
grant execute on function "better_supabase"."page_organization_domains"(uuid, jsonb) to authenticated, service_role;
grant execute on function "better_supabase"."page_sso_providers"(uuid, jsonb) to authenticated, service_role;
grant execute on function "better_supabase"."sso_domain_for"(text) to anon, authenticated, service_role;
grant execute on function "better_supabase"."sso_access_token_check"(jsonb) to service_role, supabase_auth_admin;
grant execute on function "better_supabase"."scim_list_users"(uuid) to service_role;
grant execute on function "better_supabase"."scim_get_user"(uuid, uuid) to service_role;
grant execute on function "better_supabase"."scim_save_user"(uuid, uuid, jsonb, integer) to service_role;
grant execute on function "better_supabase"."scim_delete_user"(uuid, uuid) to service_role;
grant execute on function "better_supabase"."scim_list_groups"(uuid) to service_role;
grant execute on function "better_supabase"."scim_get_group"(uuid, uuid) to service_role;
grant execute on function "better_supabase"."scim_save_group"(uuid, uuid, jsonb, integer) to service_role;
grant execute on function "better_supabase"."scim_delete_group"(uuid, uuid) to service_role;
