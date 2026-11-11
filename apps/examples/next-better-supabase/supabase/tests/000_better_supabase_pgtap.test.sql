-- better-supabase module: pgtap
-- @bsb-block pgtap@1 managed
-- @bsb-hash sha256:f3df69827e65fcec8127b2b802518a6ff146e039dfc0a7c102bf3255c03238a6
-- tests.create_user, tests.authenticate_as (by id or email), tests.authenticate_as_issued, tests.act_as, tests.visible_row_count and catalog checks (every_table_has_rls, policies_use, no_anon_policies, every_table_audited, partitions_have_rls) for `supabase test db`. Written to supabase/tests, never to your schema.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

-- Runs first (000_) and commits, so later test files can use the helpers.
create extension if not exists pgtap with schema extensions;
create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

create or replace function tests.create_user(
  email text,
  app_metadata jsonb default '{}',
  user_metadata jsonb default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    email, '', now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb || app_metadata,
    user_metadata, now(), now()
  );
  return user_id;
end;
$$;

create or replace function tests._email_of(user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email from auth.users u where u.id = user_id;
$$;

-- Runs the rest of the transaction as this user, like PostgREST does. Extra claims (tenant_id, ...) go in the JWT.
create or replace function tests.authenticate_as(user_id uuid, claims jsonb default '{}')
returns void
language plpgsql
set search_path = ''
as $$
declare
  user_email text;
begin
  user_email := tests._email_of(user_id);
  perform set_config(
    'request.jwt.claims',
    (jsonb_build_object('sub', user_id, 'role', 'authenticated', 'email', user_email, 'aud', 'authenticated') || claims)::text,
    true
  );
  set local role authenticated;
end;
$$;

-- The lookup runs as security definer, so a test that is already
-- authenticated can switch to another user by email.
create or replace function tests._user_id_by_email(user_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where u.email = user_email;
$$;

-- The same by email address: tests.authenticate_as('member@acme.test'). An
-- untyped literal or parameter resolves to this overload, so a uuid string
-- is taken as the user's id.
create or replace function tests.authenticate_as(user_email text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  found_id uuid;
begin
  if user_email ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform tests.authenticate_as(user_email::uuid);
    return;
  end if;
  found_id := tests._user_id_by_email(user_email);
  if found_id is null then
    raise exception 'tests.authenticate_as: no user with email %', user_email;
  end if;
  perform tests.authenticate_as(found_id);
end;
$$;

-- Runs as this user with the claims your custom access token hook issues, as a
-- real sign-in does. The hook defaults to auth.hook.custom_access_token of
-- config.toml at the time of gen; pass another as 'public.my_hook'.
create or replace function tests.authenticate_as_issued(user_id uuid, hook text default 'permdock.custom_access_token_hook')
returns void
language plpgsql
set search_path = ''
as $$
declare
  issued jsonb;
  base_claims jsonb;
begin
  if hook is null then
    raise exception 'tests.authenticate_as_issued: set auth.hook.custom_access_token in config.toml, or pass the hook';
  end if;
  select jsonb_build_object('sub', u.id, 'role', 'authenticated', 'email', u.email, 'aud', 'authenticated', 'app_metadata', u.raw_app_meta_data, 'user_metadata', u.raw_user_meta_data)
    into base_claims from auth.users u where u.id = authenticate_as_issued.user_id;
  if base_claims is null then
    raise exception 'tests.authenticate_as_issued: no user %', user_id;
  end if;
  execute format('select (%s(%L::jsonb)) -> ''claims''', hook, jsonb_build_object('user_id', user_id, 'claims', base_claims, 'authentication_method', 'password')::text) into issued;
  perform set_config('request.jwt.claims', issued::text, true);
  set local role authenticated;
end;
$$;

create or replace function tests.authenticate_as_anon()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  set local role anon;
end;
$$;

create or replace function tests.clear_authentication()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;

-- Acts as any role for the rest of the transaction, with the claims PostgREST
-- would set: select tests.act_as('authenticated', '<uuid>', '{"tenant_id": "<uuid>"}');
create or replace function tests.act_as(role_name text, user_id uuid default null, claims jsonb default '{}')
returns void
language plpgsql
set search_path = ''
as $$
declare
  issued jsonb := jsonb_build_object('role', role_name)
    || case when user_id is null then '{}'::jsonb else jsonb_build_object('sub', user_id) end
    || coalesce(claims, '{}'::jsonb);
begin
  perform set_config('request.jwt.claims', issued::text, true);
  execute format('set local role %I', role_name);
end;
$$;

-- How many rows the current role sees, RLS applied:
-- select is(tests.visible_row_count('public.tasks', 'status = ''open'''), 3::bigint);
create or replace function tests.visible_row_count(relation regclass, filter text default null)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  found_count bigint;
begin
  execute format('select count(*) from %s%s', relation, case when filter is null or filter = '' then '' else ' where ' || filter end)
    into found_count;
  return found_count;
end;
$$;

-- select tests.every_table_has_rls('public');
create or replace function tests.every_table_has_rls(schema_name text)
returns text
language sql
set search_path = extensions, pg_catalog
as $$
  select extensions.is(
    (
      select coalesce(array_agg(c.relname::text order by c.relname), '{}')
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = schema_name and c.relkind in ('r', 'p') and not c.relrowsecurity
    ),
    '{}'::text[],
    format('every table in %I has row level security enabled', schema_name)
  )
$$;

-- Same check under its first name.
create or replace function tests.rls_enabled(schema_name text)
returns text
language sql
set search_path = extensions, pg_catalog
as $$
  select tests.every_table_has_rls(schema_name)
$$;

-- select tests.policies_use('public', 'organization_id');
-- Every policy of the schema mentions the regular expression in its using or with check expression.
create or replace function tests.policies_use(schema_name text, pattern text)
returns text
language sql
set search_path = extensions, pg_catalog
as $$
  select extensions.is(
    (
      select coalesce(array_agg(p.tablename || '.' || p.policyname order by p.tablename, p.policyname), '{}')
      from pg_catalog.pg_policies p
      where p.schemaname = schema_name
        and coalesce(p.qual, '') !~ pattern
        and coalesce(p.with_check, '') !~ pattern
    ),
    '{}'::text[],
    format('every policy in %I uses %s', schema_name, pattern)
  )
$$;

-- select tests.no_anon_policies('public');
-- No policy of the schema applies to anon, by name or through public.
create or replace function tests.no_anon_policies(schema_name text)
returns text
language sql
set search_path = extensions, pg_catalog
as $$
  select extensions.is(
    (
      select coalesce(array_agg(p.tablename || '.' || p.policyname order by p.tablename, p.policyname), '{}')
      from pg_catalog.pg_policies p
      where p.schemaname = schema_name and (p.roles::text[] && array['anon', 'public'])
    ),
    '{}'::text[],
    format('no policy in %I applies to anon', schema_name)
  )
$$;

-- select tests.every_table_audited('public', array['sessions', '%_archive']);
-- Every table of the schema has an audit trigger, or its name matches an exempt LIKE pattern.
create or replace function tests.every_table_audited(schema_name text, exempt text[] default '{}')
returns text
language sql
set search_path = extensions, pg_catalog
as $$
  select extensions.is(
    (
      select coalesce(array_agg(c.relname::text order by c.relname), '{}')
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = schema_name
        and c.relkind in ('r', 'p')
        and not c.relispartition
        and not exists (select 1 from unnest(exempt) e where c.relname::text like e)
        and not exists (
          select 1
          from pg_catalog.pg_trigger t
          join pg_catalog.pg_proc f on f.oid = t.tgfoid
          where t.tgrelid = c.oid and not t.tgisinternal
            and (left(t.tgname, 8) = 'bsb_audit' or f.proname = 'audit_row_change')
        )
    ),
    '{}'::text[],
    format('every table in %I has an audit trigger or is exempt', schema_name)
  )
$$;

-- select tests.partitions_have_rls('public');
-- Every partition of a table with RLS has RLS too, the default partition included.
create or replace function tests.partitions_have_rls(schema_name text)
returns text
language sql
set search_path = extensions, pg_catalog
as $$
  select extensions.is(
    (
      select coalesce(array_agg(c.relname::text order by c.relname), '{}')
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_inherits i on i.inhrelid = c.oid
      join pg_catalog.pg_class parent on parent.oid = i.inhparent
      where n.nspname = schema_name and c.relispartition
        and parent.relrowsecurity and not c.relrowsecurity
    ),
    '{}'::text[],
    format('every partition in %I has row level security enabled', schema_name)
  )
$$;

create or replace function tests.expect_import_warning(result jsonb, code text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce(result -> 'warnings', '[]'::jsonb)) w
    where w.value ->> 'code' = code
  )
$$;

-- A run in pending, running, stale or canceled, for lifecycle tests.
create or replace function tests.import_run_fixture(source text, entities jsonb default '{}'::jsonb, state text default 'running')
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_status text := case tests.import_run_fixture.state when 'stale' then 'running' else tests.import_run_fixture.state end;
begin
  if v_status not in ('pending', 'running', 'canceled', 'failed', 'completed') then
    raise exception 'state must be pending, running, stale, canceled, failed or completed' using errcode = '22023';
  end if;
  insert into better_supabase.import_runs (id, tenant_id, source, status, plan, lease_expires_at, heartbeat_at)
  values (
    v_id,
    gen_random_uuid(),
    source,
    v_status,
    entities,
    case when tests.import_run_fixture.state = 'stale' then now() - interval '1 minute' else now() + interval '30 seconds' end,
    case when tests.import_run_fixture.state = 'stale' then now() - interval '1 minute' else now() end
  );
  return v_id;
end;
$$;

create or replace function tests.age_import_run(run uuid, age interval)
returns void
language sql
set search_path = ''
as $$
  update better_supabase.import_runs
  set lease_expires_at = now() - age, heartbeat_at = now() - age
  where id = run
$$;

-- Moves the stored import stamp into the past so a current subject looks edited.
create or replace function tests.bulk_touch_subjects(entity text, n integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  with touched as (
    select id from better_supabase.import_records
    where entity = bulk_touch_subjects.entity
    limit greatest(n, 0)
  )
  update better_supabase.import_records r
  set subject_imported_updated_at = now() - interval '1 day'
  from touched
  where r.id = touched.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Fails when a function body is missing a when-arm for an import entity.
create or replace function tests.assert_override_dispatches_all(signature text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_body text;
  v_missing text;
begin
  select pg_catalog.pg_get_functiondef(signature::regprocedure) into v_body;
  select string_agg(entity, ', ' order by entity) into v_missing
  from unnest(better_supabase.import_entities()) entity
  where position(('when ' || quote_literal(entity) || ' then') in v_body) = 0;
  if v_missing is not null then
    raise exception 'missing dispatch arms: %', v_missing using errcode = 'P0001';
  end if;
  return true;
end;
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
-- create_user writes auth.users as its definer; tests call it as postgres
-- before switching roles, so no API role can mint users.
revoke execute on function tests.create_user(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function tests.create_user(text, jsonb, jsonb) to postgres, service_role;

select extensions.plan(1);
select extensions.pass('better-supabase test helpers installed');
select * from extensions.finish();
