-- Organizations are public by slug: the slug lookup runs in a shared cache and reads no session.
create table public.organizations (
  id uuid primary key,
  slug text not null unique,
  name text not null
);

create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null,
  scope_id uuid not null,
  role text not null,
  primary key (user_id, scope, scope_id, role)
);

create table public.customers (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null
);
create index customers_organization_id_idx on public.customers (organization_id);

create table public.contacts (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  name text not null
);
create index contacts_organization_id_idx on public.contacts (organization_id);
create index contacts_customer_id_idx on public.contacts (customer_id);
create index contacts_user_id_idx on public.contacts (user_id);

create table public.staff (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  title text not null
);
create index staff_organization_id_idx on public.staff (organization_id);
create index staff_user_id_idx on public.staff (user_id);

create table public.quotes (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  title text not null,
  amount numeric(12, 2) not null
);
create index quotes_organization_id_idx on public.quotes (organization_id);
create index quotes_customer_id_idx on public.quotes (customer_id);

create table public.datetime_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null,
  week_start text not null check (week_start in ('monday', 'sunday')),
  date_format text not null,
  time_format text not null check (time_format in ('12h', '24h'))
);

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.customers enable row level security;
alter table public.contacts enable row level security;
alter table public.staff enable row level security;
alter table public.quotes enable row level security;
alter table public.datetime_preferences enable row level security;

create policy organizations_public_read on public.organizations
  for select to anon, authenticated using (true);

create policy datetime_preferences_own_read on public.datetime_preferences
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.organizations to anon, authenticated;
grant select on public.staff, public.quotes, public.datetime_preferences to authenticated;

-- A claim the token hook adds for the app (`supabase.hook.claims`); PermDock never reads it.
create function public.datetime_preference_claims(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'timezone', p.timezone,
    'week_start', p.week_start,
    'date_format', p.date_format,
    'time_format', p.time_format
  )
  from public.datetime_preferences p
  where p.user_id = p_user_id
$$;
revoke execute on function public.datetime_preference_claims(uuid) from public, anon, authenticated;
grant select on public.datetime_preferences to supabase_auth_admin;
create policy datetime_preferences_auth_admin_read on public.datetime_preferences
  for select to supabase_auth_admin using (true);
