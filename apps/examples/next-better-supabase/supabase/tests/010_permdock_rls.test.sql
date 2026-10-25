-- RLS on the seeded tenants: Olivia owns Acme and is a member of Globex, Mason
-- is a member of Acme, and Carla is a portal contact of Acme's customer Initech.
begin;
select extensions.plan(21);

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

-- Anonymous callers read the public organization slugs and only the quote a share-link capability names.
select tests.clear_authentication();
select tests.authenticate_as_anon();
select extensions.is(
  (select count(*)::int from public.organizations),
  2,
  'anon reads the organizations by slug'
);
select extensions.is_empty('select 1 from public.quotes', 'anon without a capability reads no quotes');
select extensions.throws_ok('select 1 from public.staff', '42501', null, 'anon has no grant on staff');
select set_config(
  'request.jwt.claims',
  '{"role": "anon", "capability": {"v": "1", "holder": "link", "on": {"resource": "quotes", "id": "00000000-0000-4000-8000-0000000000f1"}, "roles": ["guest"], "expires_at": 4102444800}}',
  true
);
select extensions.results_eq(
  'select title from public.quotes',
  array['Initech rollout'],
  'a guest capability reads only the quote it names'
);

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
  not has_function_privilege('authenticated', 'permdock.permdock_bump_authz_version_for(uuid[])', 'execute')
    and not has_function_privilege('anon', 'permdock.permdock_bump_authz_version_for(uuid[])', 'execute')
    and not has_function_privilege('service_role', 'permdock.permdock_bump_authz_version_for(uuid[])', 'execute'),
  'no API role can bump authorization versions'
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
  $$select op, changed from better_supabase.audit_events
    where table_name = 'public.quotes' and record_id = '00000000-0000-4000-8000-0000000000f1'
      and op = 'update'$$,
  $$values ('update', array['title'])$$,
  'the audit log records the changed column, not updated_at'
);
select extensions.ok(
  exists(
    select 1 from pg_trigger
    where tgrelid = 'public.quotes'::regclass
      and tgname in ('bs_updated_at', 'bsb_updated_at')
  ),
  'quotes keeps updated_at current'
);

select * from extensions.finish();
rollback;
