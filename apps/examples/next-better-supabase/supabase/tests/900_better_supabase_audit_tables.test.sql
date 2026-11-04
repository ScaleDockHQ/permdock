-- better-supabase module: audit
-- @bsb-block-test audit
-- @bsb-hash sha256:92449f724aab88641f5ba03aaa99d3b1c3362dfb8df10277623240a8fa2fb4d8
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(61);

create temp table bsb_audit_probe_0 (like "better_supabase"."share_links" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_0'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_0 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_0', ignore => '{}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_0 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_0'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_0 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_0;
end;
$$;
select extensions.has_trigger('better_supabase', 'share_links', 'bsb_audit', 'better_supabase.share_links has the bsb_audit trigger');
select extensions.trigger_is('better_supabase', 'share_links', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on better_supabase.share_links calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"better_supabase"."share_links"'::regclass) -> 'ignore', '[]'))), '{}'::text[], 'better_supabase.share_links is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"better_supabase"."share_links"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'better_supabase.share_links is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_0' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on better_supabase.share_links write entries');
drop table pg_temp.bsb_audit_probe_0;

create temp table bsb_audit_probe_1 (like "public"."contacts" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_1'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_1 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_1', ignore => '{"updated_at"}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_1 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_1'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_1 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_1;
end;
$$;
select extensions.has_trigger('public', 'contacts', 'bsb_audit', 'public.contacts has the bsb_audit trigger');
select extensions.trigger_is('public', 'contacts', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.contacts calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."contacts"'::regclass) -> 'ignore', '[]'))), '{"updated_at"}'::text[], 'public.contacts is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."contacts"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.contacts is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_1' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.contacts write entries');
select extensions.is((select count(*)::int from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_1' and (coalesce(l."changed" && '{"updated_at"}'::text[], false) or coalesce(l."old_record" ?| '{"updated_at"}'::text[], false) or coalesce(l."new_record" ?| '{"updated_at"}'::text[], false))), 0, 'entries for public.contacts leave out updated_at');
drop table pg_temp.bsb_audit_probe_1;

create temp table bsb_audit_probe_2 (like "public"."customers" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_2'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_2 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_2', ignore => '{"updated_at"}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_2 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_2'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_2 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_2;
end;
$$;
select extensions.has_trigger('public', 'customers', 'bsb_audit', 'public.customers has the bsb_audit trigger');
select extensions.trigger_is('public', 'customers', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.customers calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."customers"'::regclass) -> 'ignore', '[]'))), '{"updated_at"}'::text[], 'public.customers is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."customers"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.customers is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_2' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.customers write entries');
select extensions.is((select count(*)::int from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_2' and (coalesce(l."changed" && '{"updated_at"}'::text[], false) or coalesce(l."old_record" ?| '{"updated_at"}'::text[], false) or coalesce(l."new_record" ?| '{"updated_at"}'::text[], false))), 0, 'entries for public.customers leave out updated_at');
drop table pg_temp.bsb_audit_probe_2;

create temp table bsb_audit_probe_3 (like "public"."datetime_preferences" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_3'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_3 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_3', ignore => '{"updated_at"}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_3 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_3'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_3 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_3;
end;
$$;
select extensions.has_trigger('public', 'datetime_preferences', 'bsb_audit', 'public.datetime_preferences has the bsb_audit trigger');
select extensions.trigger_is('public', 'datetime_preferences', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.datetime_preferences calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."datetime_preferences"'::regclass) -> 'ignore', '[]'))), '{"updated_at"}'::text[], 'public.datetime_preferences is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."datetime_preferences"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.datetime_preferences is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_3' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.datetime_preferences write entries');
select extensions.is((select count(*)::int from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_3' and (coalesce(l."changed" && '{"updated_at"}'::text[], false) or coalesce(l."old_record" ?| '{"updated_at"}'::text[], false) or coalesce(l."new_record" ?| '{"updated_at"}'::text[], false))), 0, 'entries for public.datetime_preferences leave out updated_at');
drop table pg_temp.bsb_audit_probe_3;

create temp table bsb_audit_probe_4 (like "public"."organization_features" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_4'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_4 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_4', ignore => '{}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_4 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_4'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_4 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_4;
end;
$$;
select extensions.has_trigger('public', 'organization_features', 'bsb_audit', 'public.organization_features has the bsb_audit trigger');
select extensions.trigger_is('public', 'organization_features', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.organization_features calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."organization_features"'::regclass) -> 'ignore', '[]'))), '{}'::text[], 'public.organization_features is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."organization_features"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.organization_features is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_4' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.organization_features write entries');
drop table pg_temp.bsb_audit_probe_4;

create temp table bsb_audit_probe_5 (like "public"."organization_memberships" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_5'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_5 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_5', ignore => '{}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_5 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_5'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_5 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_5;
end;
$$;
select extensions.has_trigger('public', 'organization_memberships', 'bsb_audit', 'public.organization_memberships has the bsb_audit trigger');
select extensions.trigger_is('public', 'organization_memberships', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.organization_memberships calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."organization_memberships"'::regclass) -> 'ignore', '[]'))), '{}'::text[], 'public.organization_memberships is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."organization_memberships"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.organization_memberships is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_5' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.organization_memberships write entries');
drop table pg_temp.bsb_audit_probe_5;

create temp table bsb_audit_probe_6 (like "public"."organizations" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_6'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_6 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_6', ignore => '{"updated_at"}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_6 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_6'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_6 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_6;
end;
$$;
select extensions.has_trigger('public', 'organizations', 'bsb_audit', 'public.organizations has the bsb_audit trigger');
select extensions.trigger_is('public', 'organizations', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.organizations calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."organizations"'::regclass) -> 'ignore', '[]'))), '{"updated_at"}'::text[], 'public.organizations is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."organizations"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.organizations is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_6' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.organizations write entries');
select extensions.is((select count(*)::int from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_6' and (coalesce(l."changed" && '{"updated_at"}'::text[], false) or coalesce(l."old_record" ?| '{"updated_at"}'::text[], false) or coalesce(l."new_record" ?| '{"updated_at"}'::text[], false))), 0, 'entries for public.organizations leave out updated_at');
drop table pg_temp.bsb_audit_probe_6;

create temp table bsb_audit_probe_7 (like "public"."quotes" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_7'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_7 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_7', ignore => '{"updated_at"}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_7 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_7'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_7 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_7;
end;
$$;
select extensions.has_trigger('public', 'quotes', 'bsb_audit', 'public.quotes has the bsb_audit trigger');
select extensions.trigger_is('public', 'quotes', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.quotes calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."quotes"'::regclass) -> 'ignore', '[]'))), '{"updated_at"}'::text[], 'public.quotes is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."quotes"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.quotes is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_7' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.quotes write entries');
select extensions.is((select count(*)::int from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_7' and (coalesce(l."changed" && '{"updated_at"}'::text[], false) or coalesce(l."old_record" ?| '{"updated_at"}'::text[], false) or coalesce(l."new_record" ?| '{"updated_at"}'::text[], false))), 0, 'entries for public.quotes leave out updated_at');
drop table pg_temp.bsb_audit_probe_7;

create temp table bsb_audit_probe_8 (like "public"."role_permissions" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_8'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_8 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_8', ignore => '{}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_8 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_8'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_8 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_8;
end;
$$;
select extensions.has_trigger('public', 'role_permissions', 'bsb_audit', 'public.role_permissions has the bsb_audit trigger');
select extensions.trigger_is('public', 'role_permissions', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.role_permissions calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."role_permissions"'::regclass) -> 'ignore', '[]'))), '{}'::text[], 'public.role_permissions is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."role_permissions"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.role_permissions is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_8' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.role_permissions write entries');
drop table pg_temp.bsb_audit_probe_8;

create temp table bsb_audit_probe_9 (like "public"."roles" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_9'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_9 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_9', ignore => '{}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_9 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_9'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_9 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_9;
end;
$$;
select extensions.has_trigger('public', 'roles', 'bsb_audit', 'public.roles has the bsb_audit trigger');
select extensions.trigger_is('public', 'roles', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.roles calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."roles"'::regclass) -> 'ignore', '[]'))), '{}'::text[], 'public.roles is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."roles"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.roles is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_9' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.roles write entries');
drop table pg_temp.bsb_audit_probe_9;

create temp table bsb_audit_probe_10 (like "public"."staff" including defaults including identity including generated) on commit drop;
do $$
declare
  col record;
  sets text;
begin
  for col in
    select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'pg_temp.bsb_audit_probe_10'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attnotnull and a.attidentity = ''
  loop
    execute format('alter table pg_temp.bsb_audit_probe_10 alter column %I drop not null', col.attname);
  end loop;
  perform better_supabase.audit('pg_temp.bsb_audit_probe_10', ignore => '{"updated_at"}'::text[], redact => '{}'::text[]);
  insert into pg_temp.bsb_audit_probe_10 default values;
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
  where a.attrelid = 'pg_temp.bsb_audit_probe_10'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attidentity = '' and a.attgenerated = '' and v.value is not null;
  if sets is not null then
    execute format('update pg_temp.bsb_audit_probe_10 set %s', sets);
  end if;
  delete from pg_temp.bsb_audit_probe_10;
end;
$$;
select extensions.has_trigger('public', 'staff', 'bsb_audit', 'public.staff has the bsb_audit trigger');
select extensions.trigger_is('public', 'staff', 'bsb_audit', 'better_supabase', 'audit_row_change', 'bsb_audit on public.staff calls audit_row_change()');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."staff"'::regclass) -> 'ignore', '[]'))), '{"updated_at"}'::text[], 'public.staff is registered with its ignored columns');
select extensions.is(array(select jsonb_array_elements_text(coalesce(better_supabase.audit_settings('"public"."staff"'::regclass) -> 'redact', '[]'))), '{}'::text[], 'public.staff is registered with its redacted columns');
select extensions.results_eq($$select l."op"::text from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_10' order by l."id"$$, $$values ('insert'), ('update'), ('delete')$$, 'inserts, updates and deletes on public.staff write entries');
select extensions.is((select count(*)::int from "better_supabase"."audit_events" l where l."table_name" = (select n.nspname from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) || '.bsb_audit_probe_10' and (coalesce(l."changed" && '{"updated_at"}'::text[], false) or coalesce(l."old_record" ?| '{"updated_at"}'::text[], false) or coalesce(l."new_record" ?| '{"updated_at"}'::text[], false))), 0, 'entries for public.staff leave out updated_at');
drop table pg_temp.bsb_audit_probe_10;

select * from extensions.finish();
rollback;
