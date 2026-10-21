-- Custom roles an organization defines; their grants live in permdock.custom_role_permissions.
-- Clients save a role through permdock.permdock_replace_custom_role_grants_by_id, or by
-- writing public.role_permissions, which the sync trigger copies.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  key text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, key)
);

alter table public.roles enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients read.
revoke all on public.roles from anon, authenticated;

-- A member lists their organization's roles; role_permissions' policy reads them too.
grant select on public.roles to authenticated;
create policy roles_read_members on public.roles
  for select to authenticated
  using (organization_id in (select permdock.member_organization_ids()));

create trigger bs_audit after insert or update or delete on public.roles
  for each row execute function better_supabase.audit_row_change('{"ignore": [], "redact": [], "key_columns": ["id"]}');
