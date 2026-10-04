-- better-supabase sql upgrade: steps that run before the schema diff.

-- audit: version 1 to 2. Renames audit_log to audit_events (with a read-only audit_log view until 0.6), at to occurred_at, org_id to organization_id and audit_trigger() to audit_row_change(); audit() takes redact, category, event_prefix, target_type and tenant_column; audit_event() records semantic events; purge_audit_log() takes a tenant.
do $$
begin
  if to_regclass('better_supabase.audit_log') is not null
    and (select c.relkind from pg_class c where c.oid = to_regclass('better_supabase.audit_log')) in ('r', 'p')
    and to_regclass('better_supabase.audit_events') is null then
    alter table "better_supabase"."audit_log" rename to "audit_events";
  end if;
  if exists (select 1 from information_schema.columns c
      where c.table_schema = 'better_supabase' and c.table_name = 'audit_events' and c.column_name = 'at')
    and not exists (select 1 from information_schema.columns c
      where c.table_schema = 'better_supabase' and c.table_name = 'audit_events' and c.column_name = 'occurred_at') then
    alter table "better_supabase"."audit_events" rename column "at" to "occurred_at";
  end if;
  if exists (select 1 from information_schema.columns c
      where c.table_schema = 'better_supabase' and c.table_name = 'audit_events' and c.column_name = 'org_id')
    and not exists (select 1 from information_schema.columns c
      where c.table_schema = 'better_supabase' and c.table_name = 'audit_events' and c.column_name = 'organization_id') then
    alter table "better_supabase"."audit_events" rename column "org_id" to "organization_id";
  end if;
  if to_regclass('better_supabase.audit_log_record_idx') is not null
    and to_regclass('better_supabase.audit_events_record_idx') is null then
    alter index "better_supabase"."audit_log_record_idx" rename to "audit_events_record_idx";
  end if;
  if to_regclass('better_supabase.audit_log_org_idx') is not null
    and to_regclass('better_supabase.audit_events_organization_idx') is null then
    alter index "better_supabase"."audit_log_org_idx" rename to "audit_events_organization_idx";
  end if;
end;
$$;
do $$
begin
  if to_regprocedure('better_supabase.audit_trigger()') is not null
    and to_regprocedure('better_supabase.audit_row_change()') is null then
    alter function "better_supabase"."audit_trigger"() rename to "audit_row_change";
  end if;
end;
$$;
drop function if exists better_supabase.audit(regclass, text[], boolean);
drop function if exists better_supabase.purge_audit_log(interval, integer);
