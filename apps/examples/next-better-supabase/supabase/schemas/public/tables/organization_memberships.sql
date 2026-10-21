-- better-supabase's tenant block adopts this view (blocks.tenant.tables.memberships), so
-- share links and the other tenant blocks read PermDock's memberships instead of a second table.
-- A user holding two roles in one organization appears once, with the earliest.
create view public.organization_memberships
  with (security_invoker = true)
as
select distinct on (scope_id, user_id)
  scope_id as organization_id,
  user_id,
  role,
  created_at
from public.memberships
where scope = 'organization'
order by scope_id, user_id, created_at, role;

revoke all on public.organization_memberships from anon, authenticated;
