-- What a Supabase project already has, so plain Postgres can run the migrations:
-- the API and owner roles, auth.users and the auth.uid() / auth.jwt() readers of request.jwt.claims,
-- plus the realtime.messages and storage.objects columns and helpers the generated policies read.
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
create schema realtime;
create table realtime.messages (
  id bigint generated always as identity primary key,
  topic text not null,
  extension text not null
);
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text
$$;
create schema storage;
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema realtime, storage to anon, authenticated;
