create table roles (
  id int primary key,
  key text not null,
  organization_id text,
  audience text not null default 'organization',
  unique (organization_id, key)
);
create table organization_users (
  organization_id text not null,
  user_id text not null,
  tier text,
  role_id int references roles (id)
);
create table user_roles (
  user_id text not null,
  role_id int not null references roles (id)
);
create table jobs (
  id text primary key,
  organization_id text not null,
  assignee_id text not null,
  team_id text not null
);
create table customers (id text primary key, organization_id text not null);

insert into roles values
  (1, 'admin', null, 'organization'),
  (2, 'technician', null, 'organization'),
  (3, 'support', null, 'system'),
  (10, 'dispatcher', 'acme', 'organization');
insert into organization_users values
  ('acme', 'u-admin', null, 1),
  ('acme', 'u-tech', 'pro', 2),
  ('acme', 'u-pro', 'pro', null),
  ('acme', 'u-dispatch', null, 10),
  ('globex', 'u-globex', null, 1);
insert into user_roles values ('u-support', 3);
insert into jobs values
  ('j-own', 'acme', 'u-tech', 't1'),
  ('j-other', 'acme', 'u-other', 't2'),
  ('j-dispatch', 'acme', 'u-dispatch', 't1'),
  ('j-globex', 'globex', 'u-globex', 't9');
insert into customers values ('c-acme', 'acme'), ('c-globex', 'globex');
grant select, update on jobs, customers to authenticated;
