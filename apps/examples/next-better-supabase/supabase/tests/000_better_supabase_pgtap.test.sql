-- better-supabase SQL kit: pgtap (0.5.1)
-- @bs-kit pgtap@1 managed
-- tests.create_user, tests.authenticate_as and tests.rls_enabled for `supabase test db`. Written to supabase/tests, never to your schema.
-- Managed by `better-supabase sql add`; re-running it overwrites this file.
-- Change it through `kits` in better-supabase.config.ts and the module's SQL hooks.

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
as $$
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  set local role anon;
end;
$$;

create or replace function tests.clear_authentication()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;

-- select tests.rls_enabled('public');
create or replace function tests.rls_enabled(schema_name text)
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

grant execute on all functions in schema tests to anon, authenticated, service_role;
-- create_user writes auth.users as its definer; tests call it as postgres
-- before switching roles, so no API role can mint users.
revoke execute on function tests.create_user(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function tests.create_user(text, jsonb, jsonb) to postgres, service_role;

select extensions.plan(1);
select extensions.pass('better-supabase test helpers installed');
select * from extensions.finish();
