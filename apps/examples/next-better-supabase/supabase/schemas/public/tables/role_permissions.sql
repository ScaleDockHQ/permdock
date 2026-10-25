-- The permission keys of each custom role, as the app's role editor stores them.
-- rls.customRoles.from.sync copies every write into permdock.custom_role_permissions,
-- and refuses an entry the signed-in caller may not hand out.
create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission text not null,
  created_at timestamptz not null default now(),
  primary key (role_id, permission)
);

alter table public.role_permissions enable row level security;
-- Supabase's default privileges grant every table to the API roles; grant back only what clients use.
revoke all on public.role_permissions from anon, authenticated;

grant select, insert, delete on public.role_permissions to authenticated;

-- Holding roles.manage in the role's organization admits the write; the sync trigger then checks what it hands out.
create policy role_permissions_manage on public.role_permissions
  for all to authenticated
  using (exists (
    select 1 from public.roles r
    where r.id = role_id
      and r.organization_id in (select permdock.permitted_organization_ids_by_permission('roles.manage'))
  ))
  with check (exists (
    select 1 from public.roles r
    where r.id = role_id
      and r.organization_id in (select permdock.permitted_organization_ids_by_permission('roles.manage'))
  ));

-- A read-only support or impersonation session reads role permissions but never changes them.
create policy role_permissions_insert_read_only_actors on public.role_permissions
  as restrictive for insert to authenticated
  with check ((select permdock.permdock_actor_may_write()));
create policy role_permissions_update_read_only_actors on public.role_permissions
  as restrictive for update to authenticated
  using ((select permdock.permdock_actor_may_write()))
  with check ((select permdock.permdock_actor_may_write()));
create policy role_permissions_delete_read_only_actors on public.role_permissions
  as restrictive for delete to authenticated
  using ((select permdock.permdock_actor_may_write()));

create trigger bsb_audit after insert or update or delete on public.role_permissions
  for each row execute function better_supabase.audit_row_change('{"ignore": [], "redact": [], "key_columns": ["role_id", "permission"]}');
