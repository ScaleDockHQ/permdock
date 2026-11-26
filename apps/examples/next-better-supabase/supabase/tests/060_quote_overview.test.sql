-- The shared overview is the tenant total for a caller who holds quotes.list.
begin;
select extensions.plan(2);

select tests.authenticate_as(
  '00000000-0000-4000-8000-0000000000a1',
  '{"tenant_id":"00000000-0000-4000-8000-0000000000b1"}'::jsonb
);

select extensions.is(
  public.quotes_overview_payload(),
  2,
  'an Acme owner reads the shared overview total'
);

select tests.authenticate_as('00000000-0000-4000-8000-0000000000a3');

select extensions.is(
  public.quotes_overview_payload(),
  0,
  'a contact with no tenant on the token reads no overview'
);

select * from extensions.finish();
rollback;
