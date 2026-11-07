-- Lienlink's own tables. PermDock helpers read them; generate does not create them.
create schema better_supabase;
create schema private;

create table better_supabase.memberships (
  organization_id uuid not null,
  user_id uuid not null,
  role text not null,
  disabled_at timestamptz
);

create table better_supabase.membership_roles (
  organization_id uuid not null,
  user_id uuid not null,
  role text not null
);

create table better_supabase.team_members (
  team_id uuid not null,
  organization_id uuid not null,
  user_id uuid not null
);

create table public.jobs (
  id uuid primary key,
  organization_id uuid not null,
  owner_id uuid not null,
  team_id uuid not null
);

create table public.job_parties (
  id uuid primary key,
  job_id uuid not null references public.jobs (id) on delete cascade,
  name text not null
);

-- A null organization_id is a platform role.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  name text not null
);

create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission text not null,
  level text
);

create table public.platform_user_roles (
  user_id uuid not null,
  role text not null
);

create function private.is_team_member(p_owner uuid, p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_owner = auth.uid()
    or p_team in (
      select t.team_id from better_supabase.team_members t where t.user_id = auth.uid()
    )
$$;
