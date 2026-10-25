-- better-supabase module: pgtap
-- @bsb-block pgtap@1 managed
-- @bsb-hash sha256:8e7bcbbf2f39f3fb6a6e3d4db8fd0d7afd7c3ccb25c3791276f3bc08057e8e03
-- tests.create_user, tests.authenticate_as and catalog checks (every_table_has_rls, policies_use, no_anon_policies, every_table_audited, partitions_have_rls) for `supabase test db`. Written to supabase/tests, never to your schema.
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

-- Runs the rest of the transaction as this user, like PostgREST does. Extra claims (tenant_id, ...) go in the JWT.
create or replace function tests.authenticate_as(user_id uuid, claims jsonb default '{}')
returns void
language plpgsql
set search_path = ''
as $$
declare
  user_email text;
begin
  select u.email into user_email from auth.users u where u.id = user_id;
  perform set_config(
    'request.jwt.claims',
    (jsonb_build_object('sub', user_id, 'role', 'authenticated', 'email', user_email, 'aud', 'authenticated') || claims)::text,
    true
  );
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

grant execute on all functions in schema tests to anon, authenticated, service_role;
-- create_user writes auth.users as its definer; tests call it as postgres
-- before switching roles, so no API role can mint users.
revoke execute on function tests.create_user(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function tests.create_user(text, jsonb, jsonb) to postgres, service_role;

select extensions.plan(1);
select extensions.pass('better-supabase test helpers installed');
select * from extensions.finish();
