-- Tables, seed and the query the explain bench plans. The helpers and policies
-- come from `permdock rls generate` over explain-bench/permdock.config.ts, applied after this file.
-- 50 organisations of 200 rows per table; the bench user is a member of five.

create table public.bench_members (
  organization_id uuid not null,
  user_id uuid not null,
  role text not null,
  primary key (organization_id, user_id)
);
create index on public.bench_members (user_id);

create table public.bench_t01 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t01 (organization_id);
create table public.bench_t02 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t02 (organization_id);
create table public.bench_t03 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t03 (organization_id);
create table public.bench_t04 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t04 (organization_id);
create table public.bench_t05 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t05 (organization_id);
create table public.bench_t06 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t06 (organization_id);
create table public.bench_t07 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t07 (organization_id);
create table public.bench_t08 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t08 (organization_id);
create table public.bench_t09 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t09 (organization_id);
create table public.bench_t10 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payload text not null
);
create index on public.bench_t10 (organization_id);

create table public.bench_doc (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  owner_id uuid,
  payload text not null
);
create index on public.bench_doc (organization_id);

create table public.bench_orgs as
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid as id
  from generate_series(1, 50) as n;

insert into public.bench_members
  select id, '11111111-1111-4111-8111-111111111111', 'member'
  from public.bench_orgs
  where id::text < '00000000-0000-4000-8000-000000000006';

insert into public.bench_t01 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_t02 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_t03 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_t04 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_t05 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_t06 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_t07 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_t08 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_t09 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_t10 (organization_id, payload) select o.id, 'row ' || g from public.bench_orgs o, generate_series(1, 200) g;
insert into public.bench_doc (organization_id, owner_id, payload)
  select o.id, case when g % 10 = 0 then '11111111-1111-4111-8111-111111111111'::uuid end, 'row ' || g
  from public.bench_orgs o, generate_series(1, 200) g;

analyze;

-- One statement scans the ten org tables and the row-helper table, so their policies share one helper memo.
create or replace function public.explain_ten_tables()
returns bigint
language sql
stable
as $$
  select (select count(*) from public.bench_t01)
    + (select count(*) from public.bench_t02)
    + (select count(*) from public.bench_t03)
    + (select count(*) from public.bench_t04)
    + (select count(*) from public.bench_t05)
    + (select count(*) from public.bench_t06)
    + (select count(*) from public.bench_t07)
    + (select count(*) from public.bench_t08)
    + (select count(*) from public.bench_t09)
    + (select count(*) from public.bench_t10)
    + (select count(*) from public.bench_doc)
$$;
grant execute on function public.explain_ten_tables() to authenticated;
grant select on all tables in schema public to authenticated;
