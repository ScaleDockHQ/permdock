-- The audit kit's per-tenant retention hook: better_supabase.purge_audit_log()
-- calls it for each entry's organization. Null keeps purge_audit_log's older_than.
create function public.audit_retention(tenant uuid)
returns interval
language sql
stable
set search_path = ''
as $$
  select null::interval
$$;

revoke execute on function public.audit_retention(uuid) from public, anon, authenticated;
