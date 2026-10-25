-- Staff roles per organization: the app's table under better-supabase's memberships
-- block (blocks.memberships.tables.memberships). PermDock reads it with
-- blockMembershipSource. Only the service role writes it.
create table public.organization_memberships (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- Supabase's default privileges grant every table to the API roles. The memberships
-- block adds row level security, the user_id index and select for authenticated.
revoke all on public.organization_memberships from anon, authenticated;

-- A member reads their own rows and their organizations' members, the block's bsb_memberships_read.
create policy organization_memberships_read on public.organization_memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or organization_id in (select better_supabase.member_organization_ids()));

create trigger bsb_audit after insert or update or delete on public.organization_memberships
  for each row execute function better_supabase.audit_row_change();
