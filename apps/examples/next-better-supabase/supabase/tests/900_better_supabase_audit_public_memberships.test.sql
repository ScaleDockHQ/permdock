-- better-supabase module: audit (0.5.1)
-- @bs-module-test audit
-- Managed by `better-supabase sql add`; re-running it overwrites this file.
-- Change it through `sql.modules` in better-supabase.config.ts and the module's SQL hooks.

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(5);

create temp table bs_audit_probe (like "public"."memberships" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bs_audit_probe'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bs_audit_probe alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bs_audit_probe', ignore => '{}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bs_audit_probe default values;
  select string_agg(format('%I = %s', a.attname, v.value), ', ') into sets
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_type t on t.oid = a.atttypid
  cross join lateral (
    select case
      when t.typtype = 'e' then quote_literal((select e.enumlabel from pg_catalog.pg_enum e where e.enumtypid = t.oid order by e.enumsortorder limit 1)) || '::' || format_type(t.oid, null)
      when t.typtype <> 'b' then null
      when t.typname = 'uuid' then 'gen_random_uuid()'
      when t.typname in ('json', 'jsonb') then quote_literal('{"probe": true}') || '::' || t.typname
      when t.typname = 'bool' then 'true'
      when t.typname in ('date') then quote_literal('2001-02-03') || '::date'
      when t.typname in ('time', 'timetz') then quote_literal('04:05:06') || '::' || t.typname
      when t.typcategory = 'D' then quote_literal('2001-02-03 04:05:06+00') || '::' || t.typname
      when t.typcategory = 'N' then '1'
      when t.typcategory = 'S' then quote_literal('p')
      when t.typcategory = 'A' then quote_literal('{}') || '::' || format_type(t.oid, null)
    end as value
  ) v
  where a.attrelid = 'pg_temp.bs_audit_probe'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bs_audit_probe set %s', sets);
  end if;
  delete from pg_temp.bs_audit_probe;
end;
$$;

select extensions.has_trigger('public', 'memberships', 'bs_audit', 'public.memberships has the bs_audit trigger');
select extensions.trigger_is('public', 'memberships', 'bs_audit', 'better_supabase', 'audit_row_change', 'bs_audit on public.memberships calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."memberships"'::regclass) -> 'ignore', '[]'))), '{}'::text[], 'public.memberships is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."memberships"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.memberships is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bs_audit_probe' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.memberships write entries');

select * from extensions.finish();
rollback;
