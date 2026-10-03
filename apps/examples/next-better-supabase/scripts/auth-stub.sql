-- What a Supabase project already has, so plain Postgres can run the migrations:
-- the API and owner roles, auth.users and the auth.uid() / auth.jwt() readers of request.jwt.claims.
do $$ begin create role postgres nologin; exception when duplicate_object then null; end $$;
create role anon nologin;
create role service_role nologin bypassrls;
create role authenticated nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text not null unique,
  raw_app_meta_data jsonb not null default '{}',
  raw_user_meta_data jsonb not null default '{}'
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to anon, authenticated, supabase_auth_admin;
grant execute on all functions in schema auth to anon, authenticated, supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to anon, authenticated;
