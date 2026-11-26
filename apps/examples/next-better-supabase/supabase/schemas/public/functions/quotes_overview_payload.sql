-- language sql, security invoker, stable. The helper call is a string literal
-- and the only table is tenant-shared, so inspect lists it in sharedFunctions.
create or replace function public.quotes_overview_payload()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(total), 0)::integer
  from public.quote_overviews
  where permdock.permdock_organization_has_active('quotes.list');
$$;

revoke all on function public.quotes_overview_payload() from public, anon;
grant execute on function public.quotes_overview_payload() to authenticated;
