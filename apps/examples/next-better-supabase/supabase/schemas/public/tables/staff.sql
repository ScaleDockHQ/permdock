create table public.staff (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index staff_user_id_idx on public.staff (user_id);

alter table public.staff enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients read.
revoke all on public.staff from anon, authenticated;

grant select on public.staff to authenticated;

create trigger bs_updated_at before update on public.staff
  for each row execute function better_supabase.set_updated_at('updated_at');
create trigger bs_audit after insert or update or delete on public.staff
  for each row execute function better_supabase.audit_row_change();
