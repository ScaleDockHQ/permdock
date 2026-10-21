-- A write to public.role_permissions passes the checks of
-- permdock_replace_custom_role_grants: a member who manages roles cannot hand
-- out a permission they lack, not even on a role they hold.
begin;
select extensions.plan(6);

-- Olivia, the owner, gives estimator roles.manage and quotes.read and assigns it to Mason.
insert into public.role_permissions (role_id, permission) values
  ('00000000-0000-4000-8000-0000000000e1', 'roles.manage'),
  ('00000000-0000-4000-8000-0000000000e1', 'quotes.read');
insert into public.memberships (user_id, scope, scope_id, role) values
  ('00000000-0000-4000-8000-0000000000a2', 'organization', '00000000-0000-4000-8000-0000000000b1', 'estimator');
insert into public.roles (id, organization_id, key, is_system) values
  ('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000b1', 'viewer', false);

select tests.authenticate_as('00000000-0000-4000-8000-0000000000a2');
select extensions.throws_ok(
  $$insert into public.role_permissions (role_id, permission) values ('00000000-0000-4000-8000-0000000000e1', 'quotes.update')$$,
  '42501',
  'permdock: estimator would allow quotes.update, which the caller may not hand out',
  'member widens a role they hold'
);
select extensions.throws_ok(
  $$select permdock.permdock_replace_custom_role_grants('00000000-0000-4000-8000-0000000000b1', 'organization', null, 'estimator', array['roles.manage', 'quotes.read', 'quotes.update'], null, null)$$,
  '42501',
  null,
  'the guarded replace refuses the same definition'
);
select extensions.lives_ok(
  $$insert into public.role_permissions (role_id, permission) values ('00000000-0000-4000-8000-0000000000e4', 'quotes.read')$$,
  'a permission the member holds is copied onto another role'
);
select extensions.results_eq(
  $$select permission from permdock.permdock_role_permissions('viewer', 'organization', '00000000-0000-4000-8000-0000000000b1', null)$$,
  $$values ('quotes.read')$$,
  'the copy of viewer holds the new entry'
);
select tests.clear_authentication();

select extensions.results_eq(
  $$select permission from permdock.custom_role_permissions where role = 'estimator' order by 1$$,
  $$values ('quotes.read'), ('roles.manage')$$,
  'the copy of estimator is unchanged'
);

select tests.authenticate_as('00000000-0000-4000-8000-0000000000a4');
select extensions.throws_ok(
  $$insert into public.role_permissions (role_id, permission) values ('00000000-0000-4000-8000-0000000000e1', 'quotes.read')$$,
  '42501',
  null,
  'the owner of another organization cannot write an Acme role'
);
select tests.clear_authentication();

select * from extensions.finish();
rollback;
