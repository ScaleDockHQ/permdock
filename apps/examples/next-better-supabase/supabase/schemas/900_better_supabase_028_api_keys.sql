-- better-supabase module: api-keys
-- @bsb-block api-keys@4 managed
-- @bsb-hash sha256:6832b9af2031e2c5caf26af00d81487c771a2dd34c2bc1cbc77c94aed1f6fe4b
-- Hashed API keys for tenants and users with scopes, expiry, rotation with a grace period, a per-key rate limit and throttled last-used tracking. verify_api_key() backs apiKeyResolver; has_scope() and api_key_tenant() go in policies.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

-- API keys: `<prefix>_<public id>_<secret>`. Only the SHA-256 of the secret
-- is stored. A key acts as its user (user_id), as its tenant (organization_id
-- without user_id), or as a user inside one tenant (both).
create table "better_supabase"."api_keys" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid,
  "user_id" uuid references auth.users (id) on delete cascade,
  "name" text not null constraint bsb_api_keys_name_check check (length(trim("name")) > 0),
  "prefix" text not null constraint bsb_api_keys_prefix_check check ("prefix" ~ '^[a-z][a-z0-9]*$'),
  "public_id" text not null unique constraint bsb_api_keys_public_id_check check ("public_id" ~ '^[0-9a-f]{16}$'),
  "secret_hash" text not null constraint bsb_api_keys_secret_hash_check check ("secret_hash" ~ '^[0-9a-f]{64}$'),
  "scopes" text[] not null default '{}',
  "rate_limit" integer constraint bsb_api_keys_rate_limit_check check ("rate_limit" > 0),
  "window_started_at" timestamptz,
  "window_hits" integer not null default 0,
  "expires_at" timestamptz,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "rotated_from" uuid references "better_supabase"."api_keys" ("id") on delete set null,
  "created_by" uuid references auth.users (id) on delete set null default auth.uid(),
  "created_at" timestamptz not null default now(),
  constraint bsb_api_keys_check check ("tenant_id" is not null or "user_id" is not null)
);
-- verify_api_key updates the counters on every request; free space on each
-- page keeps those updates HOT (no index writes).
alter table "better_supabase"."api_keys" set (fillfactor = 80);
create index api_keys_tenant_idx on "better_supabase"."api_keys" ("tenant_id");
create index api_keys_user_idx on "better_supabase"."api_keys" ("user_id");
create index api_keys_rotated_from_idx on "better_supabase"."api_keys" ("rotated_from");
create index api_keys_created_by_idx on "better_supabase"."api_keys" ("created_by");
-- What a key is for (blocks.api-keys.options.kinds), such as client or export.
alter table "better_supabase"."api_keys" add column "kind" text;
alter table "better_supabase"."api_keys" enable row level security;
revoke all on "better_supabase"."api_keys" from public, anon, authenticated;
grant all on "better_supabase"."api_keys" to service_role;

-- Creates a key. TypeScript generates the public id and the secret and sends
-- only the secret's SHA-256. A tenant key needs api_keys.manage; a personal
-- key in a tenant needs api_keys.own there.

create or replace function "better_supabase"."create_api_key"(
  name text,
  public_id text,
  secret_hash text,
  tenant uuid default null,
  personal boolean default false,
  scopes text[] default '{}',
  expires_at timestamptz default null,
  rate_limit integer default null,
  prefix text default 'bs',
  kind text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner uuid := case when personal then auth.uid() end;
  created "better_supabase"."api_keys";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if personal and owner is null then
    raise exception 'Sign in to create a personal API key' using errcode = '42501', hint = 'API_KEY_SIGN_IN';
  end if;
  if not personal and tenant is null then
    raise exception 'A tenant API key needs a tenant' using errcode = '22023', hint = 'API_KEY_TENANT_REQUIRED';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    if not personal and not coalesce(better_supabase.can('tenant', tenant, 'api_keys.manage'), false) then
      raise exception 'Not allowed to manage API keys in this tenant' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
    end if;
    if personal and tenant is not null and not coalesce(better_supabase.can('tenant', tenant, 'api_keys.own'), false) then
      raise exception 'Not allowed to create API keys in this tenant' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
    end if;
    if personal and tenant is null and exists (
      select 1 from better_supabase.member_organization_ids() as m(id)
      where m.id not in (select better_supabase.tenant_ids_with('api_keys.own'))
    ) then
      raise exception 'Not allowed to create API keys for every tenant' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
    end if;
  end if;
  if exists (select 1 from unnest(coalesce(scopes, '{}')) s where s = any ('{impersonation.start,organization.delete,organization.transfer_ownership,platform.invite,sso.manage}'::text[])) then
    raise exception 'Only a signed-in user may use this permission, so an API key cannot carry it' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
  end if;
  if (auth.jwt() -> 'api_key' is not null
      or coalesce(auth.jwt() ->> 'client_id', '') <> ''
      or auth.jwt() -> 'act' is not null) and exists (
    select 1 from unnest(coalesce(scopes, '{}')) s
    where not case
      when auth.jwt() -> 'api_key' is not null then
        coalesce(auth.jwt() -> 'api_key' -> 'scopes', '[]'::jsonb) ?| array['*', s]
      else exists (
        select 1
        from unnest(case jsonb_typeof(auth.jwt() -> 'scope')
            when 'string' then regexp_split_to_array(btrim(auth.jwt() ->> 'scope'), '\s+')
            when 'array' then array(select jsonb_array_elements_text(auth.jwt() -> 'scope'))
            else '{}'::text[]
          end) t(scope)
        where t.scope <> ''
          and (t.scope = s or exists (
            select 1 from unnest(better_supabase.scope_permissions(t.scope)) k(key)
            where better_supabase.permission_matches(k.key, s)
          ))
      )
    end
  ) then
    raise exception 'A token may only give a key the scopes it holds itself' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
  end if;
  if '*' = any (coalesce(scopes, '{}')) then
    raise exception 'The authorization provider checks scopes as exact permission keys, so a key cannot carry *' using errcode = '22023', hint = 'API_KEY_SCOPE_WILDCARD';
  end if;
  if expires_at is not null and expires_at <= now() then
    raise exception 'expires_at is in the past' using errcode = '22023', hint = 'API_KEY_EXPIRED';
  end if;
  insert into "better_supabase"."api_keys" ("tenant_id", "user_id", "name", "prefix", "public_id", "secret_hash", "scopes", "kind", "rate_limit", "expires_at")
  values (tenant, owner, create_api_key.name, create_api_key.prefix, create_api_key.public_id, create_api_key.secret_hash, coalesce(create_api_key.scopes, '{}'), create_api_key.kind, create_api_key.rate_limit, create_api_key.expires_at)
  returning * into created;
  perform better_supabase.audit_event(
    event_type => 'api_key.created',
    category => 'security',
    target_type => 'api_key',
    record_id => created."id"::text,
    target_label => created."name",
    tenant => (created."tenant_id")::uuid,
    metadata => jsonb_build_object('keyId', created."id", 'organizationId', created."tenant_id"::text, 'userId', created."user_id", 'name', created."name", 'publicId', created."public_id")
  );
  return jsonb_build_object(
    'id', created."id",
    'organization_id', created."tenant_id",
    'user_id', created."user_id",
    'name', created."name",
    'prefix', created."prefix",
    'public_id', created."public_id",
    'scopes', to_jsonb(created."scopes"),
    'kind', created."kind",
    'rate_limit', created."rate_limit",
    'expires_at', created."expires_at",
    'last_used_at', created."last_used_at",
    'revoked_at', created."revoked_at",
    'rotated_from', created."rotated_from",
    'created_by', created."created_by",
    'created_at', created."created_at",
    'state', case
      when created."revoked_at" is not null and created."revoked_at" <= now() then 'revoked'
      when created."expires_at" is not null and created."expires_at" <= now() then 'expired'
      when created."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = created."id" order by s."created_at" desc limit 1)
  );
end;
$$;

-- A tenant's keys for its managers, or the caller's own keys.
create or replace function "better_supabase"."list_api_keys"(tenant uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- One plain filter per branch, so each reads through the tenant or user index.
  if list_api_keys.tenant is null then
    return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', k."id",
    'organization_id', k."tenant_id",
    'user_id', k."user_id",
    'name', k."name",
    'prefix', k."prefix",
    'public_id', k."public_id",
    'scopes', to_jsonb(k."scopes"),
    'kind', k."kind",
    'rate_limit', k."rate_limit",
    'expires_at', k."expires_at",
    'last_used_at', k."last_used_at",
    'revoked_at', k."revoked_at",
    'rotated_from', k."rotated_from",
    'created_by', k."created_by",
    'created_at', k."created_at",
    'state', case
      when k."revoked_at" is not null and k."revoked_at" <= now() then 'revoked'
      when k."expires_at" is not null and k."expires_at" <= now() then 'expired'
      when k."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = k."id" order by s."created_at" desc limit 1)
  ) order by k."created_at" desc), '[]'::jsonb)
      from "better_supabase"."api_keys" k where k."user_id" = auth.uid());
  end if;
  if coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_api_keys.tenant, 'api_keys.manage'), false) then
    return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', k."id",
    'organization_id', k."tenant_id",
    'user_id', k."user_id",
    'name', k."name",
    'prefix', k."prefix",
    'public_id', k."public_id",
    'scopes', to_jsonb(k."scopes"),
    'kind', k."kind",
    'rate_limit', k."rate_limit",
    'expires_at', k."expires_at",
    'last_used_at', k."last_used_at",
    'revoked_at', k."revoked_at",
    'rotated_from', k."rotated_from",
    'created_by', k."created_by",
    'created_at', k."created_at",
    'state', case
      when k."revoked_at" is not null and k."revoked_at" <= now() then 'revoked'
      when k."expires_at" is not null and k."expires_at" <= now() then 'expired'
      when k."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = k."id" order by s."created_at" desc limit 1)
  ) order by k."created_at" desc), '[]'::jsonb)
      from "better_supabase"."api_keys" k where k."tenant_id" = list_api_keys.tenant);
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', k."id",
    'organization_id', k."tenant_id",
    'user_id', k."user_id",
    'name', k."name",
    'prefix', k."prefix",
    'public_id', k."public_id",
    'scopes', to_jsonb(k."scopes"),
    'kind', k."kind",
    'rate_limit', k."rate_limit",
    'expires_at', k."expires_at",
    'last_used_at', k."last_used_at",
    'revoked_at', k."revoked_at",
    'rotated_from', k."rotated_from",
    'created_by', k."created_by",
    'created_at', k."created_at",
    'state', case
      when k."revoked_at" is not null and k."revoked_at" <= now() then 'revoked'
      when k."expires_at" is not null and k."expires_at" <= now() then 'expired'
      when k."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = k."id" order by s."created_at" desc limit 1)
  ) order by k."created_at" desc), '[]'::jsonb)
    from "better_supabase"."api_keys" k where k."tenant_id" = list_api_keys.tenant and k."user_id" = auth.uid());
end;
$$;

-- A tenant's API keys for its managers (the caller's own otherwise) or, without a tenant, the caller's personal keys, as a keyset page, newest first (ADR 1077). filters is { userId, revoked (each a value or a list), search, sort (createdAt, name, expiresAt, lastUsedAt), direction, facet, count, limit, after, offset, paged, total, totalCap }.
create or replace function "better_supabase"."page_api_keys"(tenant uuid default null, filters jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_api_keys.filters, '{}'::jsonb);
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
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('revoked') then
      raise exception 'facet is one of revoked' using errcode = '22023', hint = 'API_KEY_INVALID';
    end if;
    with s as (
      select (case v_facet when 'revoked' then ((x."revoked_at" is not null)::text)::text end) as v
      from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
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
      select 1 from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('createdAt', 'name', 'expiresAt', 'lastUsedAt') then
    raise exception 'sort is one of createdAt, name, expiresAt, lastUsedAt' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."name", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."name" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."name" <= (v_after ->> 0)::text and ((x."name" < (v_after ->> 0)::text) or (x."name" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."name" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."expires_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."expires_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."expires_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."expires_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."expires_at" <= (v_after ->> 0)::timestamptz and ((x."expires_at" < (v_after ->> 0)::timestamptz) or (x."expires_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."expires_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'lastUsedAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."last_used_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."last_used_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."last_used_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'lastUsedAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."last_used_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."last_used_at" <= (v_after ->> 0)::timestamptz and ((x."last_used_at" < (v_after ->> 0)::timestamptz) or (x."last_used_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."last_used_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$$;

create or replace function "better_supabase"."revoke_api_key"(key uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  found "better_supabase"."api_keys";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into found from "better_supabase"."api_keys" k where k."id" = revoke_api_key.key;
  if found."id" is null or not ((found."tenant_id" is not null and coalesce(better_supabase.can('tenant', found."tenant_id", 'api_keys.manage'), false)) or coalesce(found."user_id" = auth.uid(), false) or coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'API key not found' using errcode = 'P0002', hint = 'API_KEY_NOT_FOUND';
  end if;
  update "better_supabase"."api_keys" k set "revoked_at" = now()
  where k."id" = found."id" and (k."revoked_at" is null or k."revoked_at" > now());
  perform better_supabase.audit_event(
    event_type => 'api_key.revoked',
    category => 'security',
    target_type => 'api_key',
    record_id => found."id"::text,
    target_label => found."name",
    tenant => (found."tenant_id")::uuid,
    metadata => jsonb_build_object('keyId', found."id", 'organizationId', found."tenant_id"::text, 'userId', found."user_id", 'name', found."name", 'publicId', found."public_id")
  );
  return true;
end;
$$;

-- Replaces a key with a new secret. The old key keeps working for grace,
-- so deployments can switch over.
create or replace function "better_supabase"."rotate_api_key"(
  key uuid,
  public_id text,
  secret_hash text,
  grace interval default interval '1 day'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  old "better_supabase"."api_keys";
  created "better_supabase"."api_keys";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into old from "better_supabase"."api_keys" k where k."id" = rotate_api_key.key for update;
  if old."id" is null or not ((old."tenant_id" is not null and coalesce(better_supabase.can('tenant', old."tenant_id", 'api_keys.manage'), false)) or coalesce(old."user_id" = auth.uid(), false) or coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'API key not found' using errcode = 'P0002', hint = 'API_KEY_NOT_FOUND';
  end if;
  -- The new secret acts as the key's user, so only that user rotates a personal key.
  if old."user_id" is not null and old."user_id" is distinct from auth.uid() and not coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'Only its own user can rotate a personal key; revoke it instead' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
  end if;
  if (auth.jwt() -> 'api_key' is not null
      or coalesce(auth.jwt() ->> 'client_id', '') <> ''
      or auth.jwt() -> 'act' is not null) and exists (
    select 1 from unnest(coalesce(old."scopes", '{}')) s
    where not case
      when auth.jwt() -> 'api_key' is not null then
        coalesce(auth.jwt() -> 'api_key' -> 'scopes', '[]'::jsonb) ?| array['*', s]
      else exists (
        select 1
        from unnest(case jsonb_typeof(auth.jwt() -> 'scope')
            when 'string' then regexp_split_to_array(btrim(auth.jwt() ->> 'scope'), '\s+')
            when 'array' then array(select jsonb_array_elements_text(auth.jwt() -> 'scope'))
            else '{}'::text[]
          end) t(scope)
        where t.scope <> ''
          and (t.scope = s or exists (
            select 1 from unnest(better_supabase.scope_permissions(t.scope)) k(key)
            where better_supabase.permission_matches(k.key, s)
          ))
      )
    end
  ) then
    raise exception 'A token may only give a key the scopes it holds itself' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
  end if;
  if old."revoked_at" is not null and old."revoked_at" <= now() then
    raise exception 'A revoked API key cannot be rotated' using errcode = '22023', hint = 'API_KEY_REVOKED';
  end if;
  if old."expires_at" is not null and old."expires_at" <= now() then
    raise exception 'An expired API key cannot be rotated' using errcode = '22023', hint = 'API_KEY_EXPIRED';
  end if;
  if grace is null or grace < interval '0' then
    raise exception 'grace must be zero or more' using errcode = '22023', hint = 'API_KEY_GRACE';
  end if;
  insert into "better_supabase"."api_keys" ("tenant_id", "user_id", "name", "prefix", "public_id", "secret_hash", "scopes", "kind", "rate_limit", "expires_at", "rotated_from")
  values (old."tenant_id", old."user_id", old."name", old."prefix", rotate_api_key.public_id, rotate_api_key.secret_hash, old."scopes", old."kind", old."rate_limit", old."expires_at", old."id")
  returning * into created;
  update "better_supabase"."api_keys" k set "revoked_at" = now() + grace where k."id" = old."id";
  perform better_supabase.audit_event(
    event_type => 'api_key.rotated',
    category => 'security',
    target_type => 'api_key',
    record_id => created."id"::text,
    target_label => created."name",
    tenant => (created."tenant_id")::uuid,
    metadata => jsonb_build_object('keyId', created."id", 'organizationId', created."tenant_id"::text, 'userId', created."user_id", 'name', created."name", 'publicId', created."public_id", 'previousKeyId', old."id")
  );
  return jsonb_build_object(
    'id', created."id",
    'organization_id', created."tenant_id",
    'user_id', created."user_id",
    'name', created."name",
    'prefix', created."prefix",
    'public_id', created."public_id",
    'scopes', to_jsonb(created."scopes"),
    'kind', created."kind",
    'rate_limit', created."rate_limit",
    'expires_at', created."expires_at",
    'last_used_at', created."last_used_at",
    'revoked_at', created."revoked_at",
    'rotated_from', created."rotated_from",
    'created_by', created."created_by",
    'created_at', created."created_at",
    'state', case
      when created."revoked_at" is not null and created."revoked_at" <= now() then 'revoked'
      when created."expires_at" is not null and created."expires_at" <= now() then 'expired'
      when created."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = created."id" order by s."created_at" desc limit 1)
  );
end;
$$;

-- Server-side: checks a presented key and counts the request. Returns
-- { status: 'ok', key } or { status: 'invalid' | 'rate_limited', retry_after }.
-- It never raises for a bad key, so the counter update commits.
create or replace function "better_supabase"."verify_api_key"(public_id text, secret_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  found "better_supabase"."api_keys";
  started timestamptz;
  hits integer;
begin
  select * into found from "better_supabase"."api_keys" k where k."public_id" = verify_api_key.public_id;
  if found."id" is null
    or found."secret_hash" <> verify_api_key.secret_hash
    or (found."expires_at" is not null and found."expires_at" <= now())
    or (found."revoked_at" is not null and found."revoked_at" <= now())
    or (found."user_id" is not null and better_supabase.user_disabled(found."user_id"))
    or (found."user_id" is not null and exists (
      select 1 from auth.users u
      where u.id = found."user_id" and (u.banned_until > now() or u.deleted_at is not null)
    ))
    or (found."tenant_id" is not null and better_supabase.tenant_disabled(found."tenant_id"))
    or (found."user_id" is not null and found."tenant_id" is not null
      and better_supabase.organization_member_role(found."tenant_id", found."user_id") is null)
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if found."rate_limit" is not null then
    -- One update counts the hit and, for an allowed request, touches last_used_at.
    update "better_supabase"."api_keys" k set
      "window_started_at" = case when (k."window_started_at" is null or k."window_started_at" + interval '1 minute' <= now()) then now() else k."window_started_at" end,
      "window_hits" = case when (k."window_started_at" is null or k."window_started_at" + interval '1 minute' <= now()) then 1 else k."window_hits" + 1 end,
      "last_used_at" = case when case when (k."window_started_at" is null or k."window_started_at" + interval '1 minute' <= now()) then 1 else k."window_hits" + 1 end <= k."rate_limit" and (k."last_used_at" is null or k."last_used_at" + interval '60 seconds' <= now()) then now() else k."last_used_at" end
    where k."id" = found."id"
    returning k."window_started_at", k."window_hits" into started, hits;
    if hits > found."rate_limit" then
      return jsonb_build_object(
        'status', 'rate_limited',
        'retry_after', greatest(1, ceil(extract(epoch from started + interval '1 minute' - now()))::integer)
      );
    end if;
  elsif (found."last_used_at" is null or found."last_used_at" + interval '60 seconds' <= now()) then
    update "better_supabase"."api_keys" k set "last_used_at" = now() where k."id" = found."id";
  end if;
  return jsonb_build_object('status', 'ok', 'key', jsonb_build_object(
    'id', found."id",
    'organization_id', found."tenant_id",
    'user_id', found."user_id",
    'name', found."name",
    'prefix', found."prefix",
    'public_id', found."public_id",
    'scopes', to_jsonb(found."scopes"),
    'kind', found."kind",
    'rate_limit', found."rate_limit",
    'expires_at', found."expires_at",
    'last_used_at', found."last_used_at",
    'revoked_at', found."revoked_at",
    'rotated_from', found."rotated_from",
    'created_by', found."created_by",
    'created_at', found."created_at",
    'state', case
      when found."revoked_at" is not null and found."revoked_at" <= now() then 'revoked'
      when found."expires_at" is not null and found."expires_at" <= now() then 'expired'
      when found."revoked_at" is not null then 'grace'
      else 'active'
    end
  ));
end;
$$;

-- For policies: whether the request's API key carries scope. Requests
-- without an API key (a signed-in user) are not limited by scopes. Wrap the
-- calls in (select ...) so they run once per statement, not once per row:
--   using (organization_id = (select better_supabase.api_key_tenant()) and (select better_supabase.has_scope('deals:read')))
create or replace function "better_supabase"."has_scope"(scope text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when auth.jwt() -> 'api_key' is null then true
    else coalesce(auth.jwt() -> 'api_key' -> 'scopes', '[]'::jsonb) ?| array['*', has_scope.scope]
  end
$$;

-- The tenant of the request's tenant API key, or null.
create or replace function "better_supabase"."api_key_tenant"()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'api_key' ->> 'organization_id', '')::uuid
$$;

revoke execute on function "better_supabase"."create_api_key"(text, text, text, uuid, boolean, text[], timestamptz, integer, text, text) from public, anon;
revoke execute on function "better_supabase"."list_api_keys"(uuid) from public, anon;
revoke execute on function "better_supabase"."page_api_keys"(uuid, jsonb) from public, anon;
revoke execute on function "better_supabase"."revoke_api_key"(uuid) from public, anon;
revoke execute on function "better_supabase"."rotate_api_key"(uuid, text, text, interval) from public, anon;
revoke execute on function "better_supabase"."verify_api_key"(text, text) from public, anon, authenticated;
grant execute on function "better_supabase"."create_api_key"(text, text, text, uuid, boolean, text[], timestamptz, integer, text, text) to authenticated, service_role;
grant execute on function "better_supabase"."list_api_keys"(uuid) to authenticated, service_role;
grant execute on function "better_supabase"."page_api_keys"(uuid, jsonb) to authenticated, service_role;
grant execute on function "better_supabase"."revoke_api_key"(uuid) to authenticated, service_role;
grant execute on function "better_supabase"."rotate_api_key"(uuid, text, text, interval) to authenticated, service_role;
grant execute on function "better_supabase"."verify_api_key"(text, text) to service_role;
grant execute on function "better_supabase"."has_scope"(text) to anon, authenticated, service_role;
grant execute on function "better_supabase"."api_key_tenant"() to anon, authenticated, service_role;

-- Row audit for the module's tables (blocks.audit.options.blockTables)
create constraint trigger bsb_audit after insert or update or delete on better_supabase.api_keys deferrable initially deferred for each row when (better_supabase.import_run() is null or current_setting('better_supabase.import_audit', true) is distinct from 'summary') execute function better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"api_key","event_prefix":"api_key"}');
