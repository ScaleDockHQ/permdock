-- Staff roles per organization. Only the token hook and the PermDock helpers read it.
create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null,
  scope_id uuid not null,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, scope, scope_id, role)
);

alter table public.memberships enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients read.
revoke all on public.memberships from anon, authenticated;

create trigger bs_audit after insert or update or delete on public.memberships
  for each row execute function better_supabase.audit_trigger();
