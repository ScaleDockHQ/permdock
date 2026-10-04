-- Per-organization plan features, as the `features` claim (`supabase.hook.claims`).
-- A stand-in for better-supabase's entitlements kit, which reads the Stripe Sync
-- Engine tables this example does not run.
create table public.organization_features (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  feature text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, feature)
);

alter table public.organization_features enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients read.
revoke all on public.organization_features from anon, authenticated;

create policy organization_features_auth_admin_read on public.organization_features
  for select to supabase_auth_admin using (true);

grant select on public.organization_features to supabase_auth_admin;

create trigger bs_audit after insert or update or delete on public.organization_features
  for each row execute function better_supabase.audit_row_change();
