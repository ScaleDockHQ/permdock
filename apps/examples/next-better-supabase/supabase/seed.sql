-- Two organizations. Olivia owns Acme and is a member of Globex, Mason is a
-- member of Acme, and Carla is a portal contact of Acme's customer Initech.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'olivia@acme.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'mason@acme.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'carla@initech.test');

insert into public.organizations (id, slug, name) values
  ('00000000-0000-4000-8000-0000000000b1', 'acme', 'Acme'),
  ('00000000-0000-4000-8000-0000000000b2', 'globex', 'Globex');

insert into public.memberships (user_id, scope, scope_id, role) values
  ('00000000-0000-4000-8000-0000000000a1', 'organization', '00000000-0000-4000-8000-0000000000b1', 'owner'),
  ('00000000-0000-4000-8000-0000000000a1', 'organization', '00000000-0000-4000-8000-0000000000b2', 'member'),
  ('00000000-0000-4000-8000-0000000000a2', 'organization', '00000000-0000-4000-8000-0000000000b1', 'member');

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

insert into public.quotes (id, organization_id, customer_id, title, amount) values
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', 'Initech rollout', 1200),
  ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2', 'Umbrella audit', 800),
  ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000c3', 'Hooli support', 500);

insert into public.organization_features (organization_id, feature) values
  ('00000000-0000-4000-8000-0000000000b1', 'dev-mode'),
  ('00000000-0000-4000-8000-0000000000b1', 'export'),
  ('00000000-0000-4000-8000-0000000000b2', 'export');

insert into public.datetime_preferences (user_id, timezone, week_start, date_format, time_format) values
  ('00000000-0000-4000-8000-0000000000a1', 'Europe/Amsterdam', 'monday', 'dd-MM-yyyy', '24h'),
  ('00000000-0000-4000-8000-0000000000a3', 'America/New_York', 'sunday', 'MM/dd/yyyy', '12h');
