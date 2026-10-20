create table roles (id int primary key, key text not null unique);
create table tenant_users (
  tenant_id text not null,
  user_id text not null,
  tier text,
  tier_role text generated always as (
    case tier when 'business' then 'owner' end
  ) stored
);
create table user_roles (
  user_id text not null,
  tenant_id text not null,
  role_id int not null references roles (id)
);
create table jobs (
  id text primary key,
  tenant_id text not null,
  owner_id text not null,
  team_id text not null
);

create function permdock_in_team(team text) returns boolean
language sql stable as $$
  select coalesce(team = any(array(
    select jsonb_array_elements_text(
      coalesce(nullif(current_setting('app.team_ids', true), ''), '[]')::jsonb
    )
  )), false)
$$;
grant execute on function permdock_in_team(text) to authenticated;

insert into roles values (1, 'tech'), (2, 'lead');
insert into tenant_users (tenant_id, user_id, tier) values
  ('acme', 'u-owner', 'business'),
  ('acme', 'u-tech', 'starter'),
  ('acme', 'u-lead', null);
insert into user_roles values ('u-tech', 'acme', 1), ('u-lead', 'acme', 2);
insert into jobs values
  ('j-tech', 'acme', 'u-tech', 'blue'),
  ('j-blue', 'acme', 'u-other', 'blue'),
  ('j-red', 'acme', 'u-other', 'red'),
  ('j-globex', 'globex', 'u-tech', 'blue');
grant select, update on jobs to authenticated;
