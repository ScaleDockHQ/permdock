create table public.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_organization_id_idx on public.customers (organization_id);

alter table public.customers enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients read.
revoke all on public.customers from anon, authenticated;

create trigger bs_updated_at before update on public.customers
  for each row execute function better_supabase.set_updated_at('updated_at');
create trigger bs_audit after insert or update or delete on public.customers
  for each row execute function better_supabase.audit_trigger();
