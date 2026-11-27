/**
 * A CentraKit-shaped file tree: 100 organizations with three drives (two
 * company, one personal) and 645 nodes each, a parent tree four levels deep.
 * OWNER owns organizations 0 to 13 (6,020 company nodes) and holds grants
 * outside them that `requires` drops, plus 10 record grants. MEMBER reads
 * organizations 0 and 1. PLATFORM holds file.read through a global role and no
 * membership. OUTSIDER holds only a node grant and record grants.
 */
export const OWNER = "00000000-0000-4000-8000-000000000001";
export const MEMBER = "00000000-0000-4000-8000-000000000002";
export const PLATFORM = "00000000-0000-4000-8000-000000000003";
export const OUTSIDER = "00000000-0000-4000-8000-000000000004";

export const node = (organization: number, index: number): string =>
  `00000000-0000-4000-8003-${String(organization * 1000 + index).padStart(12, "0")}`;

export const drive = (organization: number, index: number): string =>
  `00000000-0000-4000-8002-${String(organization * 3 + index).padStart(12, "0")}`;

export const setupSql = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
create table public.organization_users (
  organization_id uuid not null,
  user_id uuid not null,
  role text not null,
  primary key (organization_id, user_id)
);
create index on public.organization_users (user_id);
create table public.file_drives (
  id uuid primary key,
  organization_id uuid not null,
  owner_user_id uuid,
  drive_type text not null
);
create index on public.file_drives (organization_id);
create table public.file_drive_grants (drive_id uuid not null, user_id uuid not null, primary key (drive_id, user_id));
create index on public.file_drive_grants (user_id);
create table public.file_nodes (
  id uuid primary key,
  organization_id uuid not null,
  drive_id uuid not null,
  parent_id uuid references public.file_nodes,
  restricted boolean not null default false,
  name text not null
);
create index on public.file_nodes (organization_id, drive_id, parent_id);
create index on public.file_nodes (drive_id);
create index on public.file_nodes (parent_id);
create table public.file_node_grants (node_id uuid not null, user_id uuid not null, primary key (node_id, user_id));
create index on public.file_node_grants (user_id);
create table public.file_node_record_access (node_id uuid not null, user_id uuid not null, level text not null);
create index on public.file_node_record_access (user_id, level);
create function public.file_node_record_allowed_ids(p_level text) returns setof uuid
  language sql stable security definer set search_path = '' as $$
  select a.node_id from public.file_node_record_access a
  where a.user_id = auth.uid() and a.level = p_level
$$;
grant execute on function public.file_node_record_allowed_ids(text) to authenticated;
grant select on public.file_nodes, public.file_drives to authenticated;
`;

export const seedSql = `
insert into auth.users select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(0, 200) n;
insert into public.organization_users
  select ('00000000-0000-4000-8001-' || lpad(o::text, 12, '0'))::uuid,
         ('00000000-0000-4000-8000-' || lpad((o + 100)::text, 12, '0'))::uuid, 'owner'
  from generate_series(0, 99) o;
insert into public.organization_users
  select ('00000000-0000-4000-8001-' || lpad(o::text, 12, '0'))::uuid,
         '00000000-0000-4000-8000-000000000001'::uuid, 'owner'
  from generate_series(0, 13) o;
insert into public.organization_users
  select ('00000000-0000-4000-8001-' || lpad(o::text, 12, '0'))::uuid,
         '00000000-0000-4000-8000-000000000002'::uuid, 'member'
  from generate_series(0, 1) o;
insert into public.file_drives
  select ('00000000-0000-4000-8002-' || lpad((o * 3 + d)::text, 12, '0'))::uuid,
         ('00000000-0000-4000-8001-' || lpad(o::text, 12, '0'))::uuid,
         case when d = 2 then ('00000000-0000-4000-8000-' || lpad((o + 100)::text, 12, '0'))::uuid end,
         case when d = 2 then 'personal' else 'company' end
  from generate_series(0, 99) o, generate_series(0, 2) d;
create temp table seed_nodes as
  select o, i,
         ('00000000-0000-4000-8003-' || lpad((o * 1000 + i)::text, 12, '0'))::uuid as id,
         ('00000000-0000-4000-8001-' || lpad(o::text, 12, '0'))::uuid as org,
         ('00000000-0000-4000-8002-' || lpad((o * 3 + (i % 3))::text, 12, '0'))::uuid as drive,
         case when i < 12 then null
           else ('00000000-0000-4000-8003-' || lpad((o * 1000 + (i / 4) - (((i / 4) - i) % 3 + 3) % 3)::text, 12, '0'))::uuid end as parent
  from generate_series(0, 99) o, generate_series(0, 644) i;
insert into public.file_nodes (id, organization_id, drive_id, parent_id, restricted, name)
  select id, org, drive, parent, (i % 97 = 50), 'n' || i from seed_nodes order by i;
insert into public.file_drive_grants
  select ('00000000-0000-4000-8002-' || lpad((o * 3 + 2)::text, 12, '0'))::uuid, '00000000-0000-4000-8000-000000000001'::uuid
  from generate_series(20, 22) o;
insert into public.file_node_grants
  select ('00000000-0000-4000-8003-' || lpad((o * 1000 + 8)::text, 12, '0'))::uuid, '00000000-0000-4000-8000-000000000001'::uuid
  from generate_series(30, 49) o;
insert into public.file_node_record_access
  select ('00000000-0000-4000-8003-' || lpad((o * 1000 + 100)::text, 12, '0'))::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'read'
  from generate_series(60, 69) o;
insert into public.file_node_grants
  select id, ('00000000-0000-4000-8000-' || lpad((100 + (o + 1) % 100)::text, 12, '0'))::uuid from seed_nodes where i % 7 = 3;
analyze;
insert into permdock.user_roles values ('00000000-0000-4000-8000-000000000003', 'platform');
insert into public.file_node_grants values ('${node(3, 8)}', '00000000-0000-4000-8000-000000000004');
insert into public.file_node_record_access values ('${node(3, 40)}', '00000000-0000-4000-8000-000000000004', 'read'), ('${node(4, 41)}', '00000000-0000-4000-8000-000000000004', 'update');
alter table public.file_nodes enable row level security;
create policy file_nodes_select on public.file_nodes for select to authenticated
  using (id in (select permdock.permitted_file_node_rows('fileNode.read')));
analyze;
`;
