-- One row per organization. The select policy is a tenant check of quotes.list,
-- so a share: "tenant" fill of quotes_overview_payload may read it.
create table public.quote_overviews (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  total integer not null default 0
);

alter table public.quote_overviews enable row level security;
revoke all on public.quote_overviews from anon, authenticated;
grant select on public.quote_overviews to authenticated;

create policy quote_overviews_select on public.quote_overviews
  for select to authenticated
  using (
    organization_id in (
      select permdock.permitted_organization_ids_by_permission('quotes.list')
    )
  );
