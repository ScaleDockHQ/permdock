/** The roles Supabase creates, for a plain Postgres standing in for a project. */
export const ROLES = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
`;

const AUTH = `
alter default privileges grant all on tables to anon, authenticated;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
`;

export const CUSTOM_ROLES = `${AUTH}
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.team_members (
  team_id text not null,
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
`;

export const CENTRAKIT = `${AUTH}
create table public.organizations (id uuid primary key, disabled_at timestamptz);
create table public.profiles (user_id uuid primary key, disabled_at timestamptz);
create type public.scope_type as enum ('system', 'organization', 'user', 'team');
create table public.roles (
  id uuid primary key,
  scope public.scope_type not null,
  key text not null,
  name text not null,
  system boolean not null default false,
  organization_id uuid references public.organizations (id) on delete cascade
);
alter table public.roles enable row level security;
create table public.user_roles (user_id uuid not null, role_id uuid not null references public.roles (id));
alter table public.user_roles enable row level security;
create table public.organization_users (
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  role_id uuid not null references public.roles (id),
  unique (user_id, organization_id)
);
alter table public.organization_users enable row level security;
create table public.contact_profiles (
  id uuid primary key,
  user_id uuid unique references auth.users (id) on delete set null
);
alter table public.contact_profiles enable row level security;
create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null,
  contact_profile_id uuid not null references public.contact_profiles (id) on delete cascade
);
alter table public.customer_contacts enable row level security;
`;
