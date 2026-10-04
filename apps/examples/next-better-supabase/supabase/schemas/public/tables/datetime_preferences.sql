create table public.datetime_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null,
  week_start text not null check (week_start in ('monday', 'sunday')),
  date_format text not null,
  time_format text not null check (time_format in ('12h', '24h')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.datetime_preferences enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients read.
revoke all on public.datetime_preferences from anon, authenticated;

create policy datetime_preferences_own_read on public.datetime_preferences
  for select to authenticated using (user_id = (select auth.uid()));

-- The token hook reads it through public.datetime_preference_claims.
create policy datetime_preferences_auth_admin_read on public.datetime_preferences
  for select to supabase_auth_admin using (true);

grant select on public.datetime_preferences to authenticated, supabase_auth_admin;

create trigger bs_updated_at before update on public.datetime_preferences
  for each row execute function better_supabase.set_updated_at('updated_at');
create trigger bs_audit after insert or update or delete on public.datetime_preferences
  for each row execute function better_supabase.audit_row_change();
