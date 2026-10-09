-- Organizations are public by slug: the slug lookup runs in a shared cache and reads no session.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organizations enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients read.
revoke all on public.organizations from anon, authenticated;

create policy organizations_public_read on public.organizations
  for select to anon, authenticated using (true);

grant select on public.organizations to anon, authenticated;

create trigger bs_updated_at before update on public.organizations
  for each row execute function better_supabase.set_updated_at('updated_at');
create trigger bs_audit after insert or update or delete on public.organizations
  for each row execute function better_supabase.audit_row_change('{"ignore": ["updated_at"], "redact": [], "key_columns": ["id"]}');
