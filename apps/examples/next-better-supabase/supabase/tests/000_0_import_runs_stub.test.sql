-- better-supabase 0.58's pgtap block writes tests.age_import_run as `language sql` over
-- better_supabase.import_runs, which only the imports block creates. Postgres checks a SQL
-- function's body when it is created, so 000_better_supabase_pgtap.test.sql stops there
-- (better-supabase src/sql/modules/pgtap.ts:346). This app has no imports block, so this file
-- runs first and gives the helper the columns its body names. Delete it once better-supabase
-- writes the import helpers only with the imports block.
create extension if not exists pgtap with schema extensions;

create table if not exists better_supabase.import_runs (
  id uuid primary key,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz
);
alter table better_supabase.import_runs enable row level security;
revoke all on table better_supabase.import_runs from anon, authenticated;

select extensions.plan(1);
select extensions.has_table('better_supabase', 'import_runs', 'better_supabase.import_runs exists for tests.age_import_run');
select * from extensions.finish();
