-- RLS on the seeded tenants: Olivia owns Acme and is a member of Globex, Mason
-- is a member of Acme, and Carla is a portal contact of Acme's customer Initech.
begin;
select extensions.plan(19);

select tests.rls_enabled('public');
select tests.rls_enabled('permdock');

-- The helper schema stays private: the Data API roles read none of its tables.
select extensions.ok(
  not has_table_privilege('authenticated', 'permdock.role_permissions', 'select'),
  'authenticated cannot read permdock.role_permissions'
);
select extensions.ok(
  not has_table_privilege('anon', 'permdock.user_roles', 'select'),
  'anon cannot read permdock.user_roles'
);

-- authenticate_as reads auth.users, so clear the previous user first.
-- Olivia owns Acme: every Acme quote, none of Globex's (a member reads no quotes).
select tests.authenticate_as('00000000-0000-4000-8000-0000000000a1');
select extensions.results_eq(
  'select title from public.quotes order by title',
  array['Initech rollout', 'Umbrella audit'],
  'an owner reads every quote of her organization'
);
select extensions.is(
  (select count(*)::int from public.staff),
  3,
  'Olivia reads the staff of both her organizations'
);

-- Mason is a member: staff, no quotes.
select tests.clear_authentication();
select tests.authenticate_as('00000000-0000-4000-8000-0000000000a2');
select extensions.is_empty('select 1 from public.quotes', 'a member reads no quotes');
select extensions.is(
  (select count(*)::int from public.staff),
  2,
  'a member reads the staff of his organization'
);

-- Carla is Initech's contact: Initech's quote only, no staff.
select tests.clear_authentication();
select tests.authenticate_as('00000000-0000-4000-8000-0000000000a3');
select extensions.results_eq(
  'select title from public.quotes',
  array['Initech rollout'],
  'a contact reads only her customer''s quotes'
);
select extensions.is_empty('select 1 from public.staff', 'a contact reads no staff');

-- Anonymous callers read the public organization slugs; the other tables are not granted to anon at all.
select tests.clear_authentication();
select tests.authenticate_as_anon();
select extensions.is(
  (select count(*)::int from public.organizations),
  2,
  'anon reads the organizations by slug'
);
select extensions.throws_ok('select 1 from public.quotes', '42501', null, 'anon has no grant on quotes');
select extensions.throws_ok('select 1 from public.staff', '42501', null, 'anon has no grant on staff');

-- Only the auth server runs the token hook.
select tests.clear_authentication();
select tests.authenticate_as('00000000-0000-4000-8000-0000000000a1');
select extensions.throws_ok(
  $$select permdock.custom_access_token_hook('{"user_id": "00000000-0000-4000-8000-0000000000a1", "claims": {}}')$$,
  '42501',
  null,
  'authenticated cannot call the token hook'
);
select tests.clear_authentication();

select extensions.ok(
  has_function_privilege('supabase_auth_admin', 'permdock.custom_access_token_hook(jsonb)', 'execute'),
  'the auth server can call the token hook'
);
select extensions.ok(
  permdock.custom_access_token_hook(
    '{"user_id": "00000000-0000-4000-8000-0000000000a1", "claims": {"sub": "00000000-0000-4000-8000-0000000000a1"}}'
  ) -> 'claims' ? 'memberships',
  'the hook adds the memberships claim'
);
select extensions.ok(
  permdock.custom_access_token_hook(
    '{"user_id": "00000000-0000-4000-8000-0000000000a1", "claims": {"sub": "00000000-0000-4000-8000-0000000000a1"}}'
  ) -> 'claims' ? 'authz_ver',
  'the hook adds the authz_ver claim'
);

-- Every write to a domain table lands in the audit log.
update public.quotes set title = 'Initech rollout, phase 2'
where id = '00000000-0000-4000-8000-0000000000f1';
select extensions.results_eq(
  $$select op, changed from better_supabase.audit_log
    where table_name = 'public.quotes' and record_id = '00000000-0000-4000-8000-0000000000f1'
      and op = 'update'$$,
  $$values ('update', array['title'])$$,
  'the audit log records the changed column, not updated_at'
);
select extensions.has_trigger('public', 'quotes', 'bs_updated_at', 'quotes keeps updated_at current');

select * from extensions.finish();
rollback;
