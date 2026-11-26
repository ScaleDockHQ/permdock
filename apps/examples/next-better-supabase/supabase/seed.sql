-- Two organizations. Olivia owns Acme and is a member of Globex, Gus owns
-- Globex, Mason is a member of Acme, and Carla is a portal contact of Acme's
-- customer Initech. Every organization keeps an owner (the owner role's min).
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'olivia@acme.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'mason@acme.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'carla@initech.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'gus@globex.test');

-- The password is `local-demo`. The testcontainers stub has neither column,
-- so this runs only on the Supabase stack, where Auth signs the session.
do $$
begin
  if to_regclass('auth.identities') is null then
    return;
  end if;
  update auth.users set
    instance_id = '00000000-0000-0000-0000-000000000000',
    aud = 'authenticated',
    role = 'authenticated',
    encrypted_password = extensions.crypt('local-demo', extensions.gen_salt('bf')),
    email_confirmed_at = now(),
    created_at = coalesce(created_at, now()),
    updated_at = coalesce(updated_at, now()),
    raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb,
    confirmation_token = '',
    recovery_token = '',
    email_change_token_new = '',
    email_change = ''
  where id in (
    '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000a2',
    '00000000-0000-4000-8000-0000000000a3',
    '00000000-0000-4000-8000-0000000000a4'
  );
  insert into auth.identities (
    user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  )
  select
    id, id::text, jsonb_build_object('sub', id::text, 'email', email),
    'email', now(), now(), now()
  from auth.users
  where id in (
    '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000a2',
    '00000000-0000-4000-8000-0000000000a3',
    '00000000-0000-4000-8000-0000000000a4'
  );
end $$;

insert into public.organizations (id, slug, name) values
  ('00000000-0000-4000-8000-0000000000b1', 'acme', 'Acme'),
  ('00000000-0000-4000-8000-0000000000b2', 'globex', 'Globex');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'owner'),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a1', 'member'),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a4', 'owner'),
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2', 'member');

-- Acme's custom role; system rows mirror declared roles and are not editable.
insert into public.roles (id, organization_id, key, is_system) values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1', 'estimator', false),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000b2', 'reviewer', false),
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000b1', 'owner', true);

insert into public.customers (id, organization_id, name) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1', 'Initech'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b1', 'Umbrella'),
  ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000b2', 'Hooli');

insert into public.contacts (id, organization_id, customer_id, user_id, name) values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a3', 'Carla');

insert into public.staff (id, organization_id, user_id, name, title) values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'Olivia', 'Founder'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2', 'Mason', 'Engineer'),
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a1', 'Olivia', 'Advisor');

insert into public.quotes (id, organization_id, customer_id, title, amount_minor, currency) values
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', 'Initech rollout', 120000, 'EUR'),
  ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2', 'Umbrella audit', 80000, 'EUR'),
  ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000c3', 'Hooli support', 50000, 'USD');

insert into public.organization_features (organization_id, feature) values
  ('00000000-0000-4000-8000-0000000000b1', 'dev-mode'),
  ('00000000-0000-4000-8000-0000000000b1', 'export'),
  ('00000000-0000-4000-8000-0000000000b2', 'export');

insert into public.datetime_preferences (user_id, timezone, week_start, date_format, time_format) values
  ('00000000-0000-4000-8000-0000000000a1', 'Europe/Amsterdam', 'monday', 'dd-MM-yyyy', '24h'),
  ('00000000-0000-4000-8000-0000000000a3', 'America/New_York', 'sunday', 'MM/dd/yyyy', '12h');

-- Olivia is out of office: Mason approves Acme's requests that wait on her, for a month.
insert into permdock.approval_delegations (delegator, delegate, tenant, "from", "until") values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b1', now() - interval '1 day', now() + interval '30 days');

-- A guest link to the Initech quote: /en/share/acme-initech-rollout. Only the token's hash is stored.
insert into better_supabase.share_links (tenant_id, subject_type, subject_id, token_hash, role, created_by) values
  ('00000000-0000-4000-8000-0000000000b1', 'quote', '00000000-0000-4000-8000-0000000000f1', encode(sha256(convert_to('acme-initech-rollout', 'utf8')), 'hex'), 'view', '00000000-0000-4000-8000-0000000000a1');

-- Personas for token size: users in 1, 13, 25 and 50 organizations, members
-- holding 1, 3 and 10 custom roles, and one member of a suspended organization.
insert into public.quote_overviews (organization_id, total) values
  ('00000000-0000-4000-8000-0000000000b1', 2),
  ('00000000-0000-4000-8000-0000000000b2', 1);

insert into public.organizations (id, slug, name, status)
select
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  'persona-' || n,
  'Persona ' || n,
  case when n = 50 then 'suspended' else 'active' end
from generate_series(1, 50) as n;

insert into public.roles (id, organization_id, key, is_system)
select
  ('00000000-0000-4000-8200-' || lpad(n::text, 12, '0'))::uuid,
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  'desk',
  false
from generate_series(1, 10) as n;

insert into public.role_permissions (role_id, permission)
select
  ('00000000-0000-4000-8200-' || lpad(n::text, 12, '0'))::uuid,
  'quotes.read'
from generate_series(1, 10) as n;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000101', 'orgs-1@persona.test'),
  ('00000000-0000-4000-8000-000000000113', 'orgs-13@persona.test'),
  ('00000000-0000-4000-8000-000000000125', 'orgs-25@persona.test'),
  ('00000000-0000-4000-8000-000000000150', 'orgs-50@persona.test'),
  ('00000000-0000-4000-8000-000000000201', 'roles-1@persona.test'),
  ('00000000-0000-4000-8000-000000000203', 'roles-3@persona.test'),
  ('00000000-0000-4000-8000-000000000210', 'roles-10@persona.test'),
  ('00000000-0000-4000-8000-000000000301', 'suspended@persona.test'),
  ('00000000-0000-4000-8000-000000000401', 'owner@persona.test');

insert into public.organization_memberships (organization_id, user_id, role)
select
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000401'::uuid,
  'owner'
from generate_series(1, 50) as n;

insert into public.organization_memberships (organization_id, user_id, role)
select
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000101'::uuid,
  'member'
from generate_series(1, 1) as n
union all
select
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000113'::uuid,
  'member'
from generate_series(1, 13) as n
union all
select
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000125'::uuid,
  'member'
from generate_series(1, 25) as n
union all
select
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000150'::uuid,
  'member'
from generate_series(1, 50) as n
union all
select
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000201'::uuid,
  'desk'
from generate_series(1, 1) as n
union all
select
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000203'::uuid,
  'desk'
from generate_series(1, 3) as n
union all
select
  ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000210'::uuid,
  'desk'
from generate_series(1, 10) as n
union all
select
  '00000000-0000-4000-8100-000000000050'::uuid,
  '00000000-0000-4000-8000-000000000301'::uuid,
  'member';

do $$
begin
  if to_regclass('auth.identities') is null then
    return;
  end if;
  update auth.users set
    instance_id = '00000000-0000-0000-0000-000000000000',
    aud = 'authenticated',
    role = 'authenticated',
    encrypted_password = extensions.crypt('local-demo', extensions.gen_salt('bf')),
    email_confirmed_at = now(),
    created_at = coalesce(created_at, now()),
    updated_at = coalesce(updated_at, now()),
    raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb,
    confirmation_token = '',
    recovery_token = '',
    email_change_token_new = '',
    email_change = ''
  where email like '%@persona.test';
  insert into auth.identities (
    user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  )
  select
    id, id::text, jsonb_build_object('sub', id::text, 'email', email),
    'email', now(), now(), now()
  from auth.users
  where email like '%@persona.test';
end $$;
