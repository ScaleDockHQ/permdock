-- The sessions bootstrap calls this with the request jsonb. The version itself
-- is the caller's, from the PermDock table the hook already reads.
create function public.sample_authz_version(args jsonb)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select better_supabase.caller_authz_version()
  where args is null or args is not null
$$;

revoke execute on function public.sample_authz_version(jsonb) from public, anon;
grant execute on function public.sample_authz_version(jsonb) to authenticated;
