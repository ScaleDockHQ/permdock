-- Memberships, suspension, platform roles and reporting lines are read only by the
-- token hook and the security definer helpers, so clients get no privilege on them.
create table public.organizations (
  id text primary key,
  name text not null,
  disabled_at timestamptz
);
alter table public.organizations enable row level security;
revoke all on public.organizations from anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  disabled_at timestamptz
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;

create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null,
  scope_id text not null,
  role text not null,
  primary key (user_id, scope, scope_id, role)
);
alter table public.memberships enable row level security;
revoke all on public.memberships from anon, authenticated;

create table public.platform_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  primary key (user_id, role)
);
alter table public.platform_roles enable row level security;
revoke all on public.platform_roles from anon, authenticated;

create table public.reporting_lines (
  user_id uuid not null references auth.users (id) on delete cascade,
  manager_id uuid not null references public.profiles (id) on delete cascade,
  organization_id text not null references public.organizations (id) on delete cascade,
  primary key (user_id, organization_id)
);
create index reporting_lines_manager_id_idx on public.reporting_lines (manager_id, organization_id);
create index reporting_lines_organization_id_idx on public.reporting_lines (organization_id);
alter table public.reporting_lines enable row level security;
revoke all on public.reporting_lines from anon, authenticated;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations (id) on delete cascade,
  name text not null
);
create index projects_organization_id_idx on public.projects (organization_id);
