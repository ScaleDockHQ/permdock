-- Custom roles saved by their public.roles id: the row supplies the
-- organization, so a caller cannot write another organization's role, and
-- only declared permission keys are stored.
begin;
select extensions.plan(8);

select tests.authenticate_as('00000000-0000-4000-8000-0000000000a2');
select extensions.throws_ok(
  $$select permdock.permdock_replace_custom_role_grants_by_id('00000000-0000-4000-8000-0000000000e2', array['staff.read'])$$,
  '42501',
  null,
  'a member of Acme cannot save a Globex role by its id'
);
select tests.clear_authentication();

select tests.authenticate_as('00000000-0000-4000-8000-0000000000a1');
select extensions.throws_ok(
  $$select permdock.permdock_replace_custom_role_grants_by_id('00000000-0000-4000-8000-0000000000e1', array['quotes.delete'])$$,
  '22023',
  'permdock: quotes.delete is not a declared permission',
  'an undeclared permission key is refused'
);
select extensions.throws_ok(
  $$select permdock.permdock_replace_custom_role_grants_by_id('00000000-0000-4000-8000-0000000000e9', array['quotes.read'])$$,
  'P0002',
  null,
  'an id with no role row is refused'
);
select extensions.throws_ok(
  $$select permdock.permdock_replace_custom_role_grants_by_id('00000000-0000-4000-8000-0000000000e3', array['quotes.read'])$$,
  '22023',
  null,
  'a system row is not a custom role'
);
select extensions.lives_ok(
  $$select permdock.permdock_replace_custom_role_grants_by_id('00000000-0000-4000-8000-0000000000e1', array['quotes.read'])$$,
  'the owner saves an Acme role by its id'
);
select tests.clear_authentication();

select extensions.is(
  (select count(*)::int from better_supabase.audit_events
   where event_type = 'permdock.custom_role.replaced'
     and record_id = '00000000-0000-4000-8000-0000000000e1'
     and organization_id = '00000000-0000-4000-8000-0000000000b1'),
  1,
  'the save writes one audit event in Acme'
);

insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect)
values ('00000000-0000-4000-8000-0000000000b1', 'organization', null, 'estimator', 'quotes.archive', 'allow');

set local role service_role;
select extensions.results_eq(
  $$select role_id, permission from permdock.permdock_trusted_role_permissions_by_id(array['00000000-0000-4000-8000-0000000000e1']::text[])$$,
  $$values ('00000000-0000-4000-8000-0000000000e1', 'quotes.read')$$,
  'the trusted reader returns declared keys only'
);
reset role;

set local role authenticated;
select extensions.throws_ok(
  $$select * from permdock.permdock_trusted_role_permissions_by_id(array['00000000-0000-4000-8000-0000000000e1']::text[])$$,
  '42501',
  null,
  'a client cannot call the trusted reader'
);
reset role;

select * from extensions.finish();
rollback;
