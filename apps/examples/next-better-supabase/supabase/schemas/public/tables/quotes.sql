-- Money in minor units (cents) with its ISO 4217 currency, never a float or numeric amount.
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null,
  title text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (customer_id, organization_id) references public.customers (id, organization_id) on delete cascade
);

alter table public.quotes enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients read.
revoke all on public.quotes from anon, authenticated;

grant select on public.quotes to authenticated;

create trigger bsb_updated_at before update on public.quotes
  for each row execute function better_supabase.set_updated_at('updated_at');
create trigger bsb_audit after insert or update or delete on public.quotes
  for each row execute function better_supabase.audit_row_change('{"ignore": ["updated_at"], "redact": [], "key_columns": ["id"]}');
