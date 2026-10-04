-- A portal contact holds `contact` on their customer through `user_id`.
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_organization_id_idx on public.contacts (organization_id);
create index contacts_customer_id_idx on public.contacts (customer_id);

alter table public.contacts enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients read.
revoke all on public.contacts from anon, authenticated;

create trigger bs_updated_at before update on public.contacts
  for each row execute function better_supabase.set_updated_at('updated_at');
create trigger bs_audit after insert or update or delete on public.contacts
  for each row execute function better_supabase.audit_row_change();
