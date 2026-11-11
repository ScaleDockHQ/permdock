-- better-supabase module: audit
-- @bsb-block audit@13 managed
-- @bsb-hash sha256:427081940d2d94229dd81f4ad0cbbf723a6b5acfa7ec548af50d7b15be1b0f1d
-- Records inserts, updates and deletes with the actor and changed columns for tables you register, plus semantic events through audit_event(), with redaction, an append-only guard, a tenant read policy and per-tenant retention as options.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create table "better_supabase"."audited_tables" (
  "target" regclass primary key,
  "ignore" text[] not null default '{}'
);
-- The primary key columns, read when the table is registered; composite keys are joined with ','.
alter table "better_supabase"."audited_tables" add column "key_columns" text[] not null default '{id}';
-- Per-table event naming and redaction.
alter table "better_supabase"."audited_tables" add column "redact" text[] not null default '{}';
alter table "better_supabase"."audited_tables" add column "category" text;
alter table "better_supabase"."audited_tables" add column "event_prefix" text;
alter table "better_supabase"."audited_tables" add column "target_type" text;
alter table "better_supabase"."audited_tables" add column "tenant_column" text;
alter table "better_supabase"."audited_tables" add column "label_column" text;
alter table "better_supabase"."audited_tables" enable row level security;
revoke all on "better_supabase"."audited_tables" from public, anon, authenticated;

-- The request headers, or null outside a Data API request.
create or replace function better_supabase.request_headers()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  return nullif(current_setting('request.headers', true), '')::jsonb;
exception when others then
  return null;
end;
$$;

-- One request header, or null outside a Data API request.
create or replace function better_supabase.request_header(name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  return nullif(current_setting('request.headers', true), '')::jsonb ->> request_header.name;
exception when others then
  return null;
end;
$$;

create or replace function better_supabase.request_id_or_null(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when value ~ '^[A-Za-z0-9._:;,@/+=-]{1,128}$' then value end;
$$;

-- The client address the API gateway appended to x-forwarded-for (the
-- right-most hop; clients can forge the ones before it), or null.
create or replace function better_supabase.request_ip()
returns inet
language plpgsql
stable
set search_path = ''
as $$
begin
  return nullif(trim(reverse(split_part(reverse(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for'), ',', 1))), '')::inet;
exception when others then
  return null;
end;
$$;

create table "better_supabase"."audit_events" (
  "id" bigint generated always as identity primary key,
  "table_name" text,
  "record_id" text,
  "op" text not null,
  "old_record" jsonb,
  "new_record" jsonb,
  "changed" text[],
  "actor_id" uuid,
  "actor_role" text,
  "tenant_id" uuid,
  "occurred_at" timestamptz not null default now()
);
alter table "better_supabase"."audit_events" add constraint "bsb_audit_op_check"
  check ("op" in ('insert', 'update', 'delete', 'event'));
alter table "better_supabase"."audit_events" alter column "table_name" drop not null;
-- Set when an admin acted as the user (the act claim).
alter table "better_supabase"."audit_events" add column "impersonated_by" uuid;
alter table "better_supabase"."audit_events" add column "impersonation_reason" text;
alter table "better_supabase"."audit_events" add column "support_session_id" uuid;
-- Semantic events (audit_event) and the per-table registry fill these.
alter table "better_supabase"."audit_events" add column "event_type" text;
alter table "better_supabase"."audit_events" add column "category" text;
alter table "better_supabase"."audit_events" add column "outcome" text;
alter table "better_supabase"."audit_events" add column "source" text;
alter table "better_supabase"."audit_events" add column "target_type" text;
alter table "better_supabase"."audit_events" add column "metadata" jsonb;
alter table "better_supabase"."audit_events" add column "idempotency_key" text;
-- Who acted and on what, as it was then, for audit pages.
alter table "better_supabase"."audit_events" add column "actor_kind" text;
alter table "better_supabase"."audit_events" add column "actor_label" text;
alter table "better_supabase"."audit_events" add column "tenant_label" text;
alter table "better_supabase"."audit_events" add column "target_label" text;
alter table "better_supabase"."audit_events" add column "summary" text;
alter table "better_supabase"."audit_events" add column "request_id" text;
alter table "better_supabase"."audit_events" add column "correlation_id" text;
alter table "better_supabase"."audit_events" add column "scope" text;
create index audit_events_record_idx on "better_supabase"."audit_events" ("table_name", "record_id", "occurred_at" desc);
create index audit_events_organization_idx on "better_supabase"."audit_events" ("tenant_id", "occurred_at" desc, "id" desc);
create index audit_events_actor_idx on "better_supabase"."audit_events" ("tenant_id", "actor_id", "occurred_at" desc, "id" desc);
create index audit_events_event_type_idx on "better_supabase"."audit_events" ("tenant_id", "event_type", "occurred_at" desc, "id" desc);
create index audit_events_occurred_at_idx on "better_supabase"."audit_events" ("occurred_at");
create index audit_events_correlation_idx on "better_supabase"."audit_events" ("correlation_id") where "correlation_id" is not null;
create unique index audit_events_idempotency_idx on "better_supabase"."audit_events" ("idempotency_key", "tenant_id") nulls not distinct where "idempotency_key" is not null;
alter table "better_supabase"."audit_events" enable row level security;
revoke all on "better_supabase"."audit_events" from public, anon, authenticated;
grant select on "better_supabase"."audit_events" to service_role;

create or replace function better_supabase.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entry record;
  settings jsonb;
  entry_id "better_supabase"."audit_events"."id"%type;
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  row_data jsonb := coalesce(new_row, old_row);
  changed_columns text[];
  changed_values jsonb;
  row_tenant uuid;
  v_jwt jsonb := auth.jwt();
  v_headers jsonb := better_supabase.request_headers();
  v_integration boolean := better_supabase.import_run() is not null;
  v_label text;
  path_value text;
  path_step jsonb;
begin
  -- An import run with imports.audit 'summary' audits one entry per entity at
  -- its end instead of one per row (ADR 0141).
  if v_integration and current_setting('better_supabase.import_audit', true) = 'summary' then
    return null;
  end if;
  if tg_nargs > 0 then
    settings := tg_argv[0]::jsonb;
    select array(select jsonb_array_elements_text(coalesce(settings -> 'ignore', '[]'))) as ignore,
      coalesce(
        nullif(array(select jsonb_array_elements_text(coalesce(settings -> 'key_columns', '[]'))), '{}'),
        (select array_agg(c.attname::text order by k.ord)
         from pg_catalog.pg_index i
         cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
         where i.indrelid = tg_relid and i.indisprimary),
        '{id}'
      ) as key_columns,
      array(select jsonb_array_elements_text(coalesce(settings -> 'redact', '[]'))) as redact,
      settings ->> 'category' as category, settings ->> 'event_prefix' as event_prefix,
      settings ->> 'target_type' as target_type, settings ->> 'tenant_column' as tenant_column,
      settings ->> 'label_column' as label_column,
      settings -> 'tenant_path' as tenant_path, settings ->> 'tenant_function' as tenant_function
    into entry;
  else
    select coalesce(a."ignore", '{}') as ignore, coalesce(a."key_columns", '{id}') as key_columns,
      coalesce(a."redact", '{}') as redact, a."category" as category,
      a."event_prefix" as event_prefix, a."target_type" as target_type,
      a."tenant_column" as tenant_column, a."label_column" as label_column,
      null::jsonb as tenant_path, null::text as tenant_function
    into entry
    from (select 1) one
    left join "better_supabase"."audited_tables" a on a."target" = tg_relid::regclass;
  end if;
  if position(E'\n' || coalesce(entry.target_type, tg_table_name) || ':' || coalesce((select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)), '') || E'\n' in coalesce(current_setting('better_supabase.recorded', true), '') || E'\n') > 0 then
    return null;
  end if;
  row_tenant := case when row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end;
  -- A child row without a tenant column: follow the foreign-key path
  -- registered through tenant_path, then the tenant function.
  if row_tenant is null and entry.tenant_path is not null then
    path_value := row_data ->> (entry.tenant_path ->> 'column');
    for path_step in select * from jsonb_array_elements(entry.tenant_path -> 'steps') loop
      exit when path_value is null;
      execute format('select %I::text from %s where %I::text = $1 limit 1',
        path_step ->> 'read', path_step ->> 'table', path_step ->> 'ref')
        into path_value using path_value;
    end loop;
    row_tenant := case when path_value ~* '^[0-9a-f-]{36}$' then (path_value)::uuid end;
  end if;
  if row_tenant is null and entry.tenant_function is not null then
    execute format('select %s($1)::text', (entry.tenant_function::regprocedure)::oid::regproc) into path_value using row_data;
    row_tenant := case when path_value ~* '^[0-9a-f-]{36}$' then (path_value)::uuid end;
  end if;
  old_row := old_row - entry.ignore;
  new_row := new_row - entry.ignore;
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into changed_columns
    from jsonb_each(new_row) n
    where n.value is distinct from old_row -> n.key;
    if changed_columns is null then
      return null;
    end if;
  end if;
  -- Redacted columns stay in changed, with their values masked.
  old_row := old_row || coalesce((select jsonb_object_agg(k, '"[redacted]"'::jsonb) from unnest(entry.redact) k where old_row ? k), '{}');
  new_row := new_row || coalesce((select jsonb_object_agg(k, '"[redacted]"'::jsonb) from unnest(entry.redact) k where new_row ? k), '{}');
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
  values (
    tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    lower(tg_op),
    old_row,
    new_row,
    changed_columns,
    coalesce(auth.uid(), better_supabase.acting_member()),
    coalesce(v_jwt ->> 'role', current_user),
    row_tenant,
    case when v_jwt -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'sub')::uuid end,
    v_jwt -> 'act' ->> 'reason',
    case when v_jwt -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name),
    case
      when v_integration then 'integration'
      when coalesce(v_jwt ->> 'role', '') = 'service_role' then 'service'
      when v_jwt -> 'act' ->> 'kind' = 'support' then 'support'
      when v_jwt -> 'act' is not null then 'impersonation'
      when v_jwt ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end,
    coalesce(v_jwt -> 'user_metadata' ->> 'full_name', v_jwt ->> 'email'),
    null,
    row_data ->> entry.label_column,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
  )
  returning "id" into entry_id;
  return null;
end;
$$;
revoke execute on function better_supabase.audit_row_change() from public, anon, authenticated;

-- Statement-level audit (audit(..., statement => true)): the transition tables
-- hold every row the statement changed, so the whole statement is audited with
-- one insert. An update that changes a key column is audited as a delete and an
-- insert.
create or replace function better_supabase.audit_statement_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entry record;
  settings jsonb;
  v_jwt jsonb := auth.jwt();
  v_headers jsonb := better_supabase.request_headers();
  v_integration boolean := better_supabase.import_run() is not null;
begin
  if v_integration and current_setting('better_supabase.import_audit', true) = 'summary' then
    return null;
  end if;
  if tg_nargs > 0 then
    settings := tg_argv[0]::jsonb;
    select array(select jsonb_array_elements_text(coalesce(settings -> 'ignore', '[]'))) as ignore,
      coalesce(
        nullif(array(select jsonb_array_elements_text(coalesce(settings -> 'key_columns', '[]'))), '{}'),
        (select array_agg(c.attname::text order by k.ord)
         from pg_catalog.pg_index i
         cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
         where i.indrelid = tg_relid and i.indisprimary),
        '{id}'
      ) as key_columns,
      array(select jsonb_array_elements_text(coalesce(settings -> 'redact', '[]'))) as redact,
      settings ->> 'category' as category, settings ->> 'event_prefix' as event_prefix,
      settings ->> 'target_type' as target_type, settings ->> 'tenant_column' as tenant_column,
      settings ->> 'label_column' as label_column,
      settings -> 'tenant_path' as tenant_path, settings ->> 'tenant_function' as tenant_function
    into entry;
  else
    select coalesce(a."ignore", '{}') as ignore, coalesce(a."key_columns", '{id}') as key_columns,
      coalesce(a."redact", '{}') as redact, a."category" as category,
      a."event_prefix" as event_prefix, a."target_type" as target_type,
      a."tenant_column" as tenant_column, a."label_column" as label_column,
      null::jsonb as tenant_path, null::text as tenant_function
    into entry
    from (select 1) one
    left join "better_supabase"."audited_tables" a on a."target" = tg_relid::regclass;
  end if;
  if tg_op = 'INSERT' then
    with src as (
      select null::jsonb as old_row, to_jsonb(n) as new_row from new_rows n
    ), paired as (
      select case when s.old_row is null then 'insert' when s.new_row is null then 'delete' else 'update' end as op,
        coalesce(s.new_row, s.old_row) as row_data,
        s.old_row - entry.ignore as old_row, s.new_row - entry.ignore as new_row
      from src s
    ), changed as (
      select p.*, case when p.op = 'update' then (
          select array_agg(e.key order by e.key) from jsonb_each(p.new_row) e
          where e.value is distinct from p.old_row -> e.key
        ) end as changed_columns
      from paired p
    ), kept as (
      select c.*, case when c.row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (c.row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end as row_tenant
      from changed c
      where (c.op <> 'update' or c.changed_columns is not null)
        and not (position(E'\n' || coalesce(entry.target_type, tg_table_name) || ':' || coalesce((select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)), '') || E'\n' in coalesce(current_setting('better_supabase.recorded', true), '') || E'\n') > 0)
    ), final as (
      select k.op, k.row_data, k.changed_columns, k.row_tenant,
        k.old_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.old_row ? r), '{}') as old_row,
        k.new_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.new_row ? r), '{}') as new_row
      from kept k
    )
    insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
    select tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    op,
    old_row,
    new_row,
    changed_columns,
    coalesce(auth.uid(), better_supabase.acting_member()),
    coalesce(v_jwt ->> 'role', current_user),
    row_tenant,
    case when v_jwt -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'sub')::uuid end,
    v_jwt -> 'act' ->> 'reason',
    case when v_jwt -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case op when 'insert' then 'created' when 'update' then 'updated' else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name),
    case
      when v_integration then 'integration'
      when coalesce(v_jwt ->> 'role', '') = 'service_role' then 'service'
      when v_jwt -> 'act' ->> 'kind' = 'support' then 'support'
      when v_jwt -> 'act' is not null then 'impersonation'
      when v_jwt ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end,
    coalesce(v_jwt -> 'user_metadata' ->> 'full_name', v_jwt ->> 'email'),
    null,
    row_data ->> entry.label_column,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
    from final;
  elsif tg_op = 'DELETE' then
    with src as (
      select to_jsonb(o) as old_row, null::jsonb as new_row from old_rows o
    ), paired as (
      select case when s.old_row is null then 'insert' when s.new_row is null then 'delete' else 'update' end as op,
        coalesce(s.new_row, s.old_row) as row_data,
        s.old_row - entry.ignore as old_row, s.new_row - entry.ignore as new_row
      from src s
    ), changed as (
      select p.*, case when p.op = 'update' then (
          select array_agg(e.key order by e.key) from jsonb_each(p.new_row) e
          where e.value is distinct from p.old_row -> e.key
        ) end as changed_columns
      from paired p
    ), kept as (
      select c.*, case when c.row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (c.row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end as row_tenant
      from changed c
      where (c.op <> 'update' or c.changed_columns is not null)
        and not (position(E'\n' || coalesce(entry.target_type, tg_table_name) || ':' || coalesce((select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)), '') || E'\n' in coalesce(current_setting('better_supabase.recorded', true), '') || E'\n') > 0)
    ), final as (
      select k.op, k.row_data, k.changed_columns, k.row_tenant,
        k.old_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.old_row ? r), '{}') as old_row,
        k.new_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.new_row ? r), '{}') as new_row
      from kept k
    )
    insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
    select tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    op,
    old_row,
    new_row,
    changed_columns,
    coalesce(auth.uid(), better_supabase.acting_member()),
    coalesce(v_jwt ->> 'role', current_user),
    row_tenant,
    case when v_jwt -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'sub')::uuid end,
    v_jwt -> 'act' ->> 'reason',
    case when v_jwt -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case op when 'insert' then 'created' when 'update' then 'updated' else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name),
    case
      when v_integration then 'integration'
      when coalesce(v_jwt ->> 'role', '') = 'service_role' then 'service'
      when v_jwt -> 'act' ->> 'kind' = 'support' then 'support'
      when v_jwt -> 'act' is not null then 'impersonation'
      when v_jwt ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end,
    coalesce(v_jwt -> 'user_metadata' ->> 'full_name', v_jwt ->> 'email'),
    null,
    row_data ->> entry.label_column,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
    from final;
  else
    with src as (
      select o.j as old_row, n.j as new_row
      from (select to_jsonb(r) as j, (select string_agg(to_jsonb(r) ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)) as k from old_rows r) o
      full join (select to_jsonb(r) as j, (select string_agg(to_jsonb(r) ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)) as k from new_rows r) n on o.k = n.k
    ), paired as (
      select case when s.old_row is null then 'insert' when s.new_row is null then 'delete' else 'update' end as op,
        coalesce(s.new_row, s.old_row) as row_data,
        s.old_row - entry.ignore as old_row, s.new_row - entry.ignore as new_row
      from src s
    ), changed as (
      select p.*, case when p.op = 'update' then (
          select array_agg(e.key order by e.key) from jsonb_each(p.new_row) e
          where e.value is distinct from p.old_row -> e.key
        ) end as changed_columns
      from paired p
    ), kept as (
      select c.*, case when c.row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (c.row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end as row_tenant
      from changed c
      where (c.op <> 'update' or c.changed_columns is not null)
        and not (position(E'\n' || coalesce(entry.target_type, tg_table_name) || ':' || coalesce((select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)), '') || E'\n' in coalesce(current_setting('better_supabase.recorded', true), '') || E'\n') > 0)
    ), final as (
      select k.op, k.row_data, k.changed_columns, k.row_tenant,
        k.old_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.old_row ? r), '{}') as old_row,
        k.new_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.new_row ? r), '{}') as new_row
      from kept k
    )
    insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
    select tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    op,
    old_row,
    new_row,
    changed_columns,
    coalesce(auth.uid(), better_supabase.acting_member()),
    coalesce(v_jwt ->> 'role', current_user),
    row_tenant,
    case when v_jwt -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'sub')::uuid end,
    v_jwt -> 'act' ->> 'reason',
    case when v_jwt -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case op when 'insert' then 'created' when 'update' then 'updated' else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name),
    case
      when v_integration then 'integration'
      when coalesce(v_jwt ->> 'role', '') = 'service_role' then 'service'
      when v_jwt -> 'act' ->> 'kind' = 'support' then 'support'
      when v_jwt -> 'act' is not null then 'impersonation'
      when v_jwt ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end,
    coalesce(v_jwt -> 'user_metadata' ->> 'full_name', v_jwt ->> 'email'),
    null,
    row_data ->> entry.label_column,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
    from final;
  end if;
  return null;
end;
$$;
revoke execute on function better_supabase.audit_statement_change() from public, anon, authenticated;

-- select better_supabase.audit('public.customers', ignore => '{updated_at}');
-- redact => '{api_key}' masks values but keeps them in changed;
-- event_prefix, category and target_type name the entries (event_prefix.created);
-- tenant_column overrides the module's tenant column for this table, and
-- label_column names the column kept as the entry's target label.
-- tenant_path resolves the tenant of a child row that has no tenant column
-- through foreign keys: 'group_id -> directory_groups.organization_id' reads
-- organization_id from the directory_groups row that group_id references,
-- and further '-> table.column' hops continue from there. tenant_function
-- names a function (jsonb) that returns the tenant of a row. The trigger
-- tries the row's tenant column, then the path, then the function.
-- ignore also keeps the update trigger from firing when only ignored columns
-- change, so writes such as last_run_at cost nothing.
-- statement => true audits with statement-level triggers over transition
-- tables, so a statement that changes many rows writes its entries in one
-- insert, and the restricted table's rows in one more. It needs a primary
-- key, and not deferred, tenant_path or tenant_function.
-- replace_trigger => true drops another audit trigger on the table.
-- deferred => true audits at commit, once a block function has recorded its
-- own entry (bsb.recorded), so the row isn't audited twice.
create or replace function better_supabase.audit(
  target regclass,
  ignore text[] default '{}',
  replace_trigger boolean default false,
  redact text[] default '{}',
  category text default null,
  event_prefix text default null,
  target_type text default null,
  tenant_column text default null,
  label_column text default null,
  tenant_path text default null,
  tenant_function regprocedure default null,
  deferred boolean default false,
  statement boolean default false
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  keys text[];
  path_steps jsonb := '[]';
  path_column text;
  parts text[];
  cur_rel regclass := target;
  cur_col text;
  ref_rel regclass;
  ref_col text;
  segment text;
  seg_table text;
  seg_read text;
  base_settings jsonb;
  trigger_kind text := case when audit.deferred then 'constraint ' else '' end;
  trigger_timing text := case when audit.deferred then 'deferrable initially deferred ' else '' end;
begin
  if audit.statement then
    if audit.deferred or audit.tenant_path is not null or audit.tenant_function is not null then
      raise exception 'audit(statement => true) does not combine with deferred, tenant_path or tenant_function';
    end if;
    if not exists (select 1 from pg_catalog.pg_index i where i.indrelid = audit.target and i.indisprimary) then
      raise exception 'audit(statement => true) needs a primary key on %', audit.target;
    end if;
  end if;
  if audit.tenant_path is not null then
    parts := regexp_split_to_array(btrim(audit.tenant_path), '\s*->\s*');
    if coalesce(array_length(parts, 1), 0) < 2 then
      raise exception 'tenant_path % needs a column and at least one table.column hop', audit.tenant_path;
    end if;
    path_column := parts[1];
    cur_col := path_column;
    for i in 2..array_length(parts, 1) loop
      segment := parts[i];
      seg_read := substring(segment from '[^.]+$');
      seg_table := substring(segment from '^(.*)\.[^.]+$');
      if seg_read is null or seg_table is null then
        raise exception 'tenant_path hop % must be table.column', segment;
      end if;
      select con.confrelid::regclass, a.attname::text into ref_rel, ref_col
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_attribute a on a.attrelid = con.confrelid and a.attnum = con.confkey[1]
      where con.contype = 'f' and con.conrelid = cur_rel and array_length(con.conkey, 1) = 1
        and con.conkey[1] = (
          select c.attnum from pg_catalog.pg_attribute c
          where c.attrelid = cur_rel and c.attname = cur_col and not c.attisdropped
        );
      if ref_rel is null then
        raise exception 'tenant_path: % has no foreign key on column %', cur_rel, cur_col;
      end if;
      if pg_catalog.to_regclass(case when position('.' in seg_table) > 0 then seg_table else (select n.nspname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where c.oid = audit.target) || '.' || seg_table end) is distinct from ref_rel then
        raise exception 'tenant_path: % does not reference %', cur_col, seg_table;
      end if;
      path_steps := path_steps || jsonb_build_array(jsonb_build_object('table', ref_rel::text, 'ref', ref_col, 'read', seg_read));
      cur_rel := ref_rel;
      cur_col := seg_read;
    end loop;
  end if;
  perform better_supabase.replace_equivalent_triggers(
    target, 'bsb_audit', 'audit', replace_trigger
  );
  select array_agg(c.attname::text order by k.ord) into keys
  from pg_catalog.pg_index i
  cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
  join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
  where i.indrelid = audit.target and i.indisprimary;
  delete from "better_supabase"."audited_tables" a where a."target" = audit.target;
  base_settings := jsonb_strip_nulls(jsonb_build_object(
    'ignore', to_jsonb(coalesce(audit.ignore, '{}')),
    'redact', to_jsonb(coalesce(audit.redact, '{}')),
    'key_columns', to_jsonb(keys),
    'category', audit.category,
    'event_prefix', audit.event_prefix,
    'target_type', audit.target_type,
    'tenant_column', audit.tenant_column,
    'label_column', audit.label_column,
    'tenant_path', case when audit.tenant_path is not null then jsonb_build_object('column', path_column, 'steps', path_steps) end,
    'tenant_function', audit.tenant_function::text
  ));
  execute format('drop trigger if exists bsb_audit on %s', target);
  execute format('drop trigger if exists bsb_audit_update on %s', target);
  execute format('drop trigger if exists bsb_audit_stmt_insert on %s', target);
  execute format('drop trigger if exists bsb_audit_stmt_update on %s', target);
  execute format('drop trigger if exists bsb_audit_stmt_delete on %s', target);
  if audit.statement then
    execute format(
      'create trigger bsb_audit_stmt_insert after insert on %s referencing new table as new_rows for each statement when (better_supabase.import_run() is null or current_setting(''better_supabase.import_audit'', true) is distinct from ''summary'') execute function better_supabase.audit_statement_change(%L)',
      target, base_settings::text
    );
    execute format(
      'create trigger bsb_audit_stmt_update after update on %s referencing old table as old_rows new table as new_rows for each statement when (better_supabase.import_run() is null or current_setting(''better_supabase.import_audit'', true) is distinct from ''summary'') execute function better_supabase.audit_statement_change(%L)',
      target, base_settings::text
    );
    execute format(
      'create trigger bsb_audit_stmt_delete after delete on %s referencing old table as old_rows for each statement when (better_supabase.import_run() is null or current_setting(''better_supabase.import_audit'', true) is distinct from ''summary'') execute function better_supabase.audit_statement_change(%L)',
      target, base_settings::text
    );
  elsif cardinality(coalesce(audit.ignore, '{}')) > 0 then
    execute format(
      'create %strigger bsb_audit after insert or delete on %s %sfor each row when (better_supabase.import_run() is null or current_setting(''better_supabase.import_audit'', true) is distinct from ''summary'') execute function better_supabase.audit_row_change(%L)',
      trigger_kind, target, trigger_timing, base_settings::text
    );
    execute format(
      'create %strigger bsb_audit_update after update on %s %sfor each row when (((to_jsonb(old) - %L::text[]) is distinct from (to_jsonb(new) - %L::text[])) and (better_supabase.import_run() is null or current_setting(''better_supabase.import_audit'', true) is distinct from ''summary'')) execute function better_supabase.audit_row_change(%L)',
      trigger_kind, target, trigger_timing, audit.ignore, audit.ignore, base_settings::text
    );
  else
    execute format(
      'create %strigger bsb_audit after insert or update or delete on %s %sfor each row when (better_supabase.import_run() is null or current_setting(''better_supabase.import_audit'', true) is distinct from ''summary'') execute function better_supabase.audit_row_change(%L)',
      trigger_kind, target, trigger_timing, base_settings::text
    );
  end if;
end;
$$;

create or replace function better_supabase.audit_settings(target regclass)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select convert_from(substring(t.tgargs from 1 for position('\x00'::bytea in t.tgargs) - 1), 'utf8')::jsonb
     from pg_catalog.pg_trigger t
     where t.tgrelid = audit_settings.target and t.tgname in ('bsb_audit', 'bsb_audit_stmt_insert') and t.tgnargs > 0),
    (select jsonb_strip_nulls(jsonb_build_object(
       'ignore', to_jsonb(a."ignore"), 'redact', to_jsonb(a."redact"), 'key_columns', to_jsonb(a."key_columns"),
       'category', a."category", 'event_prefix', a."event_prefix", 'target_type', a."target_type",
       'tenant_column', a."tenant_column", 'label_column', a."label_column"))
     from "better_supabase"."audited_tables" a where a."target" = audit_settings.target)
  )
$$;

create or replace function better_supabase.unaudit(target regclass)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists bsb_audit on %s', target);
  execute format('drop trigger if exists bsb_audit_update on %s', target);
  execute format('drop trigger if exists bsb_audit_stmt_insert on %s', target);
  execute format('drop trigger if exists bsb_audit_stmt_update on %s', target);
  execute format('drop trigger if exists bsb_audit_stmt_delete on %s', target);
  delete from "better_supabase"."audited_tables" a where a."target" = unaudit.target;
end;
$$;

create or replace function better_supabase.unaudit(target text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  relation regclass := pg_catalog.to_regclass(unaudit.target);
begin
  if relation is not null then
    perform better_supabase.unaudit(relation);
  end if;
  delete from "better_supabase"."audited_tables" a
  where not exists (select 1 from pg_catalog.pg_class c where c.oid = a."target"::oid);
end;
$$;

create or replace function better_supabase.audit_forget_dropped()
returns event_trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from "better_supabase"."audited_tables" a
  where a."target"::oid in (
    select d.objid from pg_catalog.pg_event_trigger_dropped_objects() d
    where d.object_type = 'table'
  );
end;
$$;


-- The audit() calls for every table in schema_name with tenant_column,
-- except tables whose name matches an exempt pattern (like 'audit_%').
-- Paste them into a schema file: static calls keep their place in a
-- pg-delta diff, where a loop over the catalog runs before the tables exist.
--   select better_supabase.audit_schema_calls('public', 'tenant_id', '{audit_%}');
create or replace function better_supabase.audit_schema_calls(
  schema_name text,
  tenant_column text,
  exempt text[] default '{}'
)
returns setof text
language sql
stable
set search_path = ''
as $$
  select format('select better_supabase.audit(%L);', format('%I.%I', n.nspname, c.relname))
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = schema_name
    and c.relkind in ('r', 'p')
    and not c.relispartition
    and exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = c.oid and a.attname = tenant_column and a.attnum > 0 and not a.attisdropped
    )
    and not exists (select 1 from unnest(exempt) e where c.relname like e)
  order by c.relname
$$;

-- Registers those tables now, for a migration or a one-off script; tables
-- already registered keep their own settings. Returns how many it added.
create or replace function better_supabase.audit_schema(
  schema_name text,
  tenant_column text,
  exempt text[] default '{}'
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  registered integer := 0;
  target regclass;
begin
  for target in
    select format('%I.%I', n.nspname, c.relname)::regclass
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = schema_name
      and c.relkind in ('r', 'p')
      and not c.relispartition
      and exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = c.oid and a.attname = audit_schema.tenant_column and a.attnum > 0 and not a.attisdropped
      )
      and not exists (select 1 from unnest(exempt) e where c.relname like e)
      and not exists (
        select 1 from pg_catalog.pg_trigger t where t.tgrelid = c.oid and t.tgname = 'bsb_audit'
      )
    order by c.relname
  loop
    perform better_supabase.audit(target);
    registered := registered + 1;
  end loop;
  return registered;
end;
$$;

revoke execute on function better_supabase.audit(regclass, text[], boolean, text[], text, text, text, text, text, text, regprocedure, boolean, boolean) from public, anon, authenticated;
revoke execute on function better_supabase.unaudit(regclass) from public, anon, authenticated;
revoke execute on function better_supabase.unaudit(text) from public, anon, authenticated;
revoke execute on function better_supabase.audit_forget_dropped() from public, anon, authenticated;
revoke execute on function better_supabase.audit_settings(regclass) from public, anon, authenticated;
revoke execute on function better_supabase.audit_schema_calls(text, text, text[]) from public, anon, authenticated;
revoke execute on function better_supabase.audit_schema(text, text, text[]) from public, anon, authenticated;

-- Records a semantic app event (invoice.sent, member.invited) next to the
-- row changes. A repeated idempotency_key returns the first entry's id.
-- actor_id, actor_kind, actor_label, ip, user_agent, session_id, request_id
-- and scope are honoured for the service role and direct admin connections,
-- which never get the request's own address, user agent or session; everyone
-- else gets auth.uid() and the request's own values. support_session,
-- impersonated_by and impersonation_reason fill the impersonation columns;
-- other callers may only name themselves as impersonated_by, from a token
-- without an act claim (an admin starting or ending their own support
-- session), and otherwise get the act claim's values. restricted goes to the
-- restricted table, with no row when every restricted value is empty; without
-- that table, passing it fails instead of dropping the details.

create or replace function better_supabase.audit_event(
  event_type text,
  category text default null,
  outcome text default 'success',
  source text default null,
  target_type text default null,
  record_id text default null,
  tenant uuid default null,
  metadata jsonb default '{}',
  idempotency_key text default null,
  restricted jsonb default null,
  actor_id uuid default null,
  summary text default null,
  target_label text default null,
  correlation_id text default null,
  actor_kind text default null,
  actor_label text default null,
  ip inet default null,
  user_agent text default null,
  session_id text default null,
  request_id text default null,
  scope text default null,
  support_session uuid default null,
  impersonated_by uuid default null,
  impersonation_reason text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing text;
  v_integration boolean := better_supabase.import_run() is not null;
  entry_id "better_supabase"."audit_events"."id"%type;
begin
  if restricted is not null or ip is not null or user_agent is not null or session_id is not null then
    raise exception 'audit_event got restricted details, and the audit module has no restricted table'
      using errcode = '22023', hint = 'Set blocks.audit.options.restricted to true.';
  end if;
  -- imports.audit 'summary' (ADR 0141): the run audits per entity at its end.
  if v_integration and current_setting('better_supabase.import_audit', true) = 'summary' then
    return null;
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    actor_id := auth.uid();
    actor_kind := null;
    actor_label := null;
    ip := null;
    user_agent := null;
    session_id := null;
    request_id := null;
    scope := null;
    if (select auth.jwt()) -> 'act' is not null or impersonated_by is distinct from auth.uid() then
      support_session := null;
      impersonated_by := null;
      impersonation_reason := null;
    end if;
  elsif actor_id is null then
    actor_id := coalesce(auth.uid(), better_supabase.acting_member());
  end if;
  if idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('better_supabase.audit_event'), pg_catalog.hashtext(coalesce(tenant::text, '') || ':' || idempotency_key));
    select l."id"::text into existing
    from "better_supabase"."audit_events" l
    where l."idempotency_key" = audit_event.idempotency_key
      and l."tenant_id" is not distinct from audit_event.tenant
    limit 1;
    if existing is not null then
      return existing;
    end if;
  end if;
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
  values (
    null,
    record_id,
    'event',
    actor_id,
    coalesce(auth.jwt() ->> 'role', current_user),
    tenant,
    coalesce(audit_event.impersonated_by, case when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'sub')::uuid end),
    coalesce(audit_event.impersonation_reason, auth.jwt() -> 'act' ->> 'reason'),
    coalesce(audit_event.support_session, case when auth.jwt() -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'session_id')::uuid end),
    event_type,
    coalesce(category, 'system'),
    coalesce(outcome, 'success'),
    coalesce(source, 'app'),
    target_type,
    coalesce(metadata, '{}'),
    idempotency_key,
    coalesce(actor_kind, case
      when v_integration then 'integration'
      when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then 'service'
      when auth.jwt() -> 'act' ->> 'kind' = 'support' then 'support'
      when auth.jwt() -> 'act' is not null then 'impersonation'
      when auth.jwt() ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end),
    coalesce(actor_label, coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() ->> 'email')),
    null,
    target_label,
    summary,
    coalesce(better_supabase.request_id_or_null(request_id), coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null(better_supabase.request_header('x-request-id')))),
    coalesce(better_supabase.request_id_or_null(correlation_id), coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null(better_supabase.request_header('x-correlation-id')))),
    coalesce(audit_event.scope, case when tenant is null then 'platform' else 'tenant' end)
  )
  returning "id" into entry_id;
  if audit_event.target_type is not null and audit_event.record_id is not null then
    perform pg_catalog.set_config('better_supabase.recorded', coalesce(pg_catalog.current_setting('better_supabase.recorded', true), '') || E'\n' || audit_event.target_type || ':' || audit_event.record_id, true);
  end if;
  return entry_id::text;
end;
$$;
revoke execute on function better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) to "service_role";

-- audit_event for a batch of events in one call (the outbox sink): each
-- element takes audit_event's argument names as keys, keeps its checks and
-- returns {"id"} or {"error"} in order.
create or replace function better_supabase.audit_event_many(events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch_event jsonb;
  results jsonb := '[]';
  batch_result text;
  failed_state text;
  failed_message text;
  failed_hint text;
begin
  if pg_catalog.jsonb_typeof(events) is distinct from 'array' then
    raise exception 'audit_event_many takes a jsonb array of events'
      using errcode = '22023', hint = 'AUDIT_BATCH_NOT_ARRAY';
  end if;
  if pg_catalog.jsonb_array_length(events) > 1000 then
    raise exception 'audit_event_many got % events, more than 1000', pg_catalog.jsonb_array_length(events)
      using errcode = '22023', hint = 'AUDIT_BATCH_TOO_LARGE';
  end if;
  for batch_event in select e from pg_catalog.jsonb_array_elements(events) e loop
    begin
      batch_result := better_supabase.audit_event(
        event_type => batch_event ->> 'event_type',
        category => batch_event ->> 'category',
        outcome => coalesce(batch_event ->> 'outcome', 'success'),
        source => batch_event ->> 'source',
        target_type => batch_event ->> 'target_type',
        record_id => batch_event ->> 'record_id',
        tenant => (batch_event ->> 'tenant')::uuid,
        metadata => coalesce(nullif(batch_event -> 'metadata', 'null'::jsonb), '{}'),
        idempotency_key => batch_event ->> 'idempotency_key',
        restricted => nullif(batch_event -> 'restricted', 'null'::jsonb),
        actor_id => (batch_event ->> 'actor_id')::uuid,
        summary => batch_event ->> 'summary',
        target_label => batch_event ->> 'target_label',
        correlation_id => batch_event ->> 'correlation_id',
        actor_kind => batch_event ->> 'actor_kind',
        actor_label => batch_event ->> 'actor_label',
        ip => (batch_event ->> 'ip')::inet,
        user_agent => batch_event ->> 'user_agent',
        session_id => batch_event ->> 'session_id',
        request_id => batch_event ->> 'request_id',
        scope => batch_event ->> 'scope',
        support_session => (batch_event ->> 'support_session')::uuid,
        impersonated_by => (batch_event ->> 'impersonated_by')::uuid,
        impersonation_reason => batch_event ->> 'impersonation_reason'
      );
      results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', batch_result));
    exception when others then
      get stacked diagnostics
        failed_state = returned_sqlstate,
        failed_message = message_text,
        failed_hint = pg_exception_hint;
      results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'error', pg_catalog.jsonb_build_object('code', failed_state, 'message', failed_message, 'hint', nullif(failed_hint, ''))
      ));
    end;
  end loop;
  return results;
end;
$$;
revoke execute on function better_supabase.audit_event_many(jsonb) from public, anon, authenticated;
grant execute on function better_supabase.audit_event_many(jsonb) to "service_role";

-- audit_event for the app's own security definer functions: it honours
-- actor_id, actor_kind, actor_label, scope and the request details from any
-- caller, so only the owner, the service role and
-- blocks.audit.options.trustedRoles may execute it. A function owned by
-- postgres calls it on behalf of a client with the real actor context.

create or replace function better_supabase.audit_event_trusted(
  event_type text,
  category text default null,
  outcome text default 'success',
  source text default null,
  target_type text default null,
  record_id text default null,
  tenant uuid default null,
  metadata jsonb default '{}',
  idempotency_key text default null,
  restricted jsonb default null,
  actor_id uuid default null,
  summary text default null,
  target_label text default null,
  correlation_id text default null,
  actor_kind text default null,
  actor_label text default null,
  ip inet default null,
  user_agent text default null,
  session_id text default null,
  request_id text default null,
  scope text default null,
  support_session uuid default null,
  impersonated_by uuid default null,
  impersonation_reason text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing text;
  v_integration boolean := better_supabase.import_run() is not null;
  entry_id "better_supabase"."audit_events"."id"%type;
begin
  if restricted is not null or ip is not null or user_agent is not null or session_id is not null then
    raise exception 'audit_event got restricted details, and the audit module has no restricted table'
      using errcode = '22023', hint = 'Set blocks.audit.options.restricted to true.';
  end if;
  -- imports.audit 'summary' (ADR 0141): the run audits per entity at its end.
  if v_integration and current_setting('better_supabase.import_audit', true) = 'summary' then
    return null;
  end if;
  actor_id := coalesce(actor_id, auth.uid());
  if idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('better_supabase.audit_event'), pg_catalog.hashtext(coalesce(tenant::text, '') || ':' || idempotency_key));
    select l."id"::text into existing
    from "better_supabase"."audit_events" l
    where l."idempotency_key" = audit_event_trusted.idempotency_key
      and l."tenant_id" is not distinct from audit_event_trusted.tenant
    limit 1;
    if existing is not null then
      return existing;
    end if;
  end if;
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
  values (
    null,
    record_id,
    'event',
    actor_id,
    coalesce(auth.jwt() ->> 'role', current_user),
    tenant,
    coalesce(audit_event_trusted.impersonated_by, case when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'sub')::uuid end),
    coalesce(audit_event_trusted.impersonation_reason, auth.jwt() -> 'act' ->> 'reason'),
    coalesce(audit_event_trusted.support_session, case when auth.jwt() -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'session_id')::uuid end),
    event_type,
    coalesce(category, 'system'),
    coalesce(outcome, 'success'),
    coalesce(source, 'app'),
    target_type,
    coalesce(metadata, '{}'),
    idempotency_key,
    coalesce(actor_kind, case
      when v_integration then 'integration'
      when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then 'service'
      when auth.jwt() -> 'act' ->> 'kind' = 'support' then 'support'
      when auth.jwt() -> 'act' is not null then 'impersonation'
      when auth.jwt() ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end),
    coalesce(actor_label, coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() ->> 'email')),
    null,
    target_label,
    summary,
    coalesce(better_supabase.request_id_or_null(request_id), coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null(better_supabase.request_header('x-request-id')))),
    coalesce(better_supabase.request_id_or_null(correlation_id), coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null(better_supabase.request_header('x-correlation-id')))),
    coalesce(audit_event_trusted.scope, case when tenant is null then 'platform' else 'tenant' end)
  )
  returning "id" into entry_id;
  if audit_event_trusted.target_type is not null and audit_event_trusted.record_id is not null then
    perform pg_catalog.set_config('better_supabase.recorded', coalesce(pg_catalog.current_setting('better_supabase.recorded', true), '') || E'\n' || audit_event_trusted.target_type || ':' || audit_event_trusted.record_id, true);
  end if;
  return entry_id::text;
end;
$$;
revoke execute on function better_supabase.audit_event_trusted(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.audit_event_trusted(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) to "service_role";

-- Entries are append-only. purge_audit_log deletes old ones: it runs as its
-- owner and sets better_supabase.audit_purge, and a role that only sets the
-- setting is not the owner.
create or replace function better_supabase.audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The setting first: the owner lookup runs only for a purge.
  if tg_op = 'DELETE' and current_setting('better_supabase.audit_purge', true) = 'on' then
    if current_user = (
      select r.rolname from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where p.oid = to_regprocedure('better_supabase.purge_audit_log(interval, integer, uuid, boolean)')
    ) then
      return old;
    end if;
  end if;
  raise exception 'audit log entries are append-only'
    using errcode = '42501', hint = 'Delete old entries with better_supabase.purge_audit_log()';
end;
$$;
revoke execute on function better_supabase.audit_append_only() from public, anon, authenticated;
create trigger "bsb_audit_append_only" before update or delete on "better_supabase"."audit_events"
  for each row execute function better_supabase.audit_append_only();
create trigger "bsb_audit_no_truncate" before truncate on "better_supabase"."audit_events"
  for each statement execute function better_supabase.audit_append_only();

-- Tables the app must not edit: append_only refuses update, delete and
-- truncate for every role; function_writes also takes the Data API write
-- privileges away, so rows arrive only through security definer functions.
create or replace function better_supabase.append_only_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name
    using errcode = '42501', hint = 'TABLE_APPEND_ONLY';
end;
$$;
revoke execute on function better_supabase.append_only_guard() from public, anon, authenticated;

create or replace function better_supabase.append_only(target regclass)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists bsb_append_only on %s', target);
  execute format('create trigger bsb_append_only before update or delete on %s for each row execute function better_supabase.append_only_guard()', target);
  execute format('drop trigger if exists bsb_append_only_truncate on %s', target);
  execute format('create trigger bsb_append_only_truncate before truncate on %s for each statement execute function better_supabase.append_only_guard()', target);
end;
$$;

create or replace function better_supabase.function_writes(target regclass)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('revoke insert, update, delete, truncate on %s from public, anon, authenticated', target);
end;
$$;

-- The hash chain for any table: chain_seq, prev_hash and row_hash columns the
-- table declares, linked per tenant column value (or one chain without a
-- tenant column) under an advisory lock.
create or replace function better_supabase.chain_row_hash(entry jsonb, prev bytea)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.sha256(
    coalesce(prev, ''::bytea)
    || pg_catalog.convert_to(pg_catalog.jsonb_strip_nulls(entry - 'prev_hash' - 'row_hash')::text, 'UTF8')
  )
$$;

create or replace function better_supabase.chain_link()
returns trigger
language plpgsql
security definer
set search_path = ''
set "TimeZone" = 'UTC'
as $$
declare
  v_column text := nullif(tg_argv[0], '');
  v_prev record;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('better_supabase.chain:' || tg_relid::text),
    pg_catalog.hashtext(coalesce(case when v_column is null then '' else pg_catalog.to_jsonb(new) ->> v_column end, ''))
  );
  if v_column is null then
    execute format('select p.chain_seq, p.row_hash from %s p where p.chain_seq is not null order by p.chain_seq desc limit 1', tg_relid::regclass)
      into v_prev;
  elsif pg_catalog.to_jsonb(new) ->> v_column is null then
    execute format('select p.chain_seq, p.row_hash from %s p where p.%I is null and p.chain_seq is not null order by p.chain_seq desc limit 1', tg_relid::regclass, v_column)
      into v_prev;
  else
    execute format('select p.chain_seq, p.row_hash from %s p where p.%I = ($1).%I and p.chain_seq is not null order by p.chain_seq desc limit 1', tg_relid::regclass, v_column, v_column)
      into v_prev using new;
  end if;
  new.chain_seq := coalesce(v_prev.chain_seq, 0) + 1;
  new.prev_hash := v_prev.row_hash;
  new.row_hash := better_supabase.chain_row_hash(pg_catalog.to_jsonb(new), v_prev.row_hash);
  return new;
end;
$$;
revoke execute on function better_supabase.chain_link() from public, anon, authenticated;

create or replace function better_supabase.chain(target regclass, tenant_column text default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_tenant text := coalesce(tenant_column, (
    select a.attname::text from pg_catalog.pg_attribute a
    where a.attrelid = target and a.attname = '"tenant_id"' and not a.attisdropped
  ), '');
begin
  if (select count(*) from pg_catalog.pg_attribute a
      where a.attrelid = target and a.attname in ('chain_seq', 'prev_hash', 'row_hash') and not a.attisdropped) <> 3 then
    raise exception 'chain needs the columns chain_seq bigint, prev_hash bytea and row_hash bytea on %', target
      using errcode = '42703', hint = 'CHAIN_COLUMNS';
  end if;
  execute format('drop trigger if exists bsb_chain on %s', target);
  execute format('create trigger bsb_chain before insert on %s for each row execute function better_supabase.chain_link(%L)', target, v_tenant);
end;
$$;

-- Signed heads of any chained table, recorded by a signing job.
create table better_supabase.chain_checkpoints (
  id bigint generated always as identity primary key,
  table_name text not null,
  tenant text,
  chain_seq bigint not null,
  row_hash bytea not null,
  key_id text not null,
  signature text not null,
  created_at timestamptz not null default now()
);
create index chain_checkpoints_idx on better_supabase.chain_checkpoints (table_name, tenant, chain_seq desc);
alter table better_supabase.chain_checkpoints enable row level security;
revoke all on better_supabase.chain_checkpoints from public, anon, authenticated;
grant all on better_supabase.chain_checkpoints to service_role;

-- Walks one chain in order. Returns valid, checked and the last hash, or the
-- first broken row and why: hash (the row changed), link (prev_hash doesn't
-- match), gap (a row is missing) or checkpoint (a signed head disagrees).
create or replace function better_supabase.verify_chain(target regclass, tenant_column text default null, tenant text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set "TimeZone" = 'UTC'
as $$
declare
  v_seq bigint;
  v_link bytea;
  v_hash bytea;
  v_entry jsonb;
  v_prev_seq bigint;
  v_prev_hash bytea;
  v_checked integer := 0;
  v_reason text;
  v_signed bytea;
  v_max bigint;
  v_where text := case
    when tenant_column is null then 'true'
    when tenant is null then format('t.%I is null', tenant_column)
    else format('t.%I::text = %L', tenant_column, tenant)
  end;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role verifies a chain' using errcode = '42501', hint = 'CHAIN_FORBIDDEN';
  end if;
  for v_seq, v_link, v_hash, v_entry in execute format(
    'select t.chain_seq, t.prev_hash, t.row_hash, pg_catalog.to_jsonb(t) as entry from %s t where %s and t.chain_seq is not null order by t.chain_seq',
    target, v_where
  ) loop
    v_reason := case
      when v_prev_seq is not null and v_seq <> v_prev_seq + 1 then 'gap'
      when v_prev_seq is not null and v_link is distinct from v_prev_hash then 'link'
      when better_supabase.chain_row_hash(v_entry, v_link) is distinct from v_hash then 'hash'
    end;
    if v_reason is null then
      select k.row_hash into v_signed from better_supabase.chain_checkpoints k
      where k.table_name = target::text and k.tenant is not distinct from verify_chain.tenant and k.chain_seq = v_seq
      order by k.id desc limit 1;
      if found and v_signed <> v_hash then
        v_reason := 'checkpoint';
      end if;
    end if;
    if v_reason is not null then
      return jsonb_build_object('valid', false, 'checked', v_checked, 'seq', v_seq, 'reason', v_reason);
    end if;
    v_checked := v_checked + 1;
    v_prev_seq := v_seq;
    v_prev_hash := v_hash;
  end loop;
  -- A signed head past the last row means the tail was removed.
  select max(k.chain_seq) into v_max from better_supabase.chain_checkpoints k
  where k.table_name = target::text and k.tenant is not distinct from verify_chain.tenant;
  if v_max is not null and v_prev_seq is distinct from v_max and coalesce(v_prev_seq, 0) < v_max then
    return jsonb_build_object('valid', false, 'checked', v_checked, 'seq', v_max, 'reason', 'gap');
  end if;
  return jsonb_build_object('valid', true, 'checked', v_checked, 'seq', v_prev_seq, 'hash', encode(v_prev_hash, 'hex'));
end;
$$;


-- Each tenant's latest row that no checkpoint covers yet, for the signing job.
create or replace function better_supabase.chain_heads(target regclass, tenant_column text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := case when tenant_column is null then 'null::text' else format('t.%I::text', tenant_column) end;
  v_heads jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role reads chain heads' using errcode = '42501', hint = 'CHAIN_FORBIDDEN';
  end if;
  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object('tenant', h.tenant, 'seq', h.chain_seq, 'hash', encode(h.row_hash, 'hex')) order by h.tenant nulls first), '[]'::jsonb)
    from (
      select distinct on (%1$s) %1$s as tenant, t.chain_seq, t.row_hash
      from %2$s t where t.chain_seq is not null
      order by %1$s, t.chain_seq desc
    ) h
    where not exists (
      select 1 from better_supabase.chain_checkpoints k
      where k.table_name = %3$L and k.tenant is not distinct from h.tenant and k.chain_seq >= h.chain_seq
    )
  $q$, v_tenant, target, target::text) into v_heads;
  return v_heads;
end;
$$;

create or replace function better_supabase.list_chain_checkpoints(target regclass, tenant text default null, max_rows integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role lists checkpoints' using errcode = '42501', hint = 'CHAIN_FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', k.id::text, 'tenant', k.tenant, 'seq', k.chain_seq, 'hash', encode(k.row_hash, 'hex'),
    'keyId', k.key_id, 'signature', k.signature, 'createdAt', k.created_at
  ) order by k.chain_seq desc), '[]'::jsonb) into v_rows
  from (
    select * from better_supabase.chain_checkpoints x
    where x.table_name = target::text and x.tenant is not distinct from list_chain_checkpoints.tenant
    order by x.chain_seq desc limit max_rows
  ) k;
  return v_rows;
end;
$$;

-- The proof for one row: the rows from it up to the first signed checkpoint
-- that covers it (or the chain head when none does), and that checkpoint.
create or replace function better_supabase.chain_proof(target regclass, tenant_column text, tenant text, seq bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set "TimeZone" = 'UTC'
as $$
declare
  v_where text := case
    when tenant_column is null then 'true'
    when tenant is null then format('t.%I is null', tenant_column)
    else format('t.%I::text = %L', tenant_column, tenant)
  end;
  v_checkpoint record;
  v_entries jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role builds chain proofs' using errcode = '42501', hint = 'CHAIN_FORBIDDEN';
  end if;
  select k.chain_seq, k.row_hash, k.key_id, k.signature into v_checkpoint from better_supabase.chain_checkpoints k
  where k.table_name = target::text and k.tenant is not distinct from chain_proof.tenant and k.chain_seq >= chain_proof.seq
  order by k.chain_seq limit 1;
  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object(
      'seq', t.chain_seq, 'prevHash', encode(t.prev_hash, 'hex'), 'rowHash', encode(t.row_hash, 'hex'), 'entry', pg_catalog.to_jsonb(t),
      'hashed', pg_catalog.jsonb_strip_nulls(pg_catalog.to_jsonb(t) - 'prev_hash' - 'row_hash')::text
    ) order by t.chain_seq), '[]'::jsonb)
    from %1$s t where %2$s and t.chain_seq between $1 and coalesce($2, t.chain_seq)
  $q$, target, v_where) into v_entries using seq, v_checkpoint.chain_seq;
  return jsonb_build_object(
    'table', target::text,
    'tenant', tenant,
    'entries', v_entries,
    'checkpoint', case when v_checkpoint.chain_seq is null then null else jsonb_build_object(
      'seq', v_checkpoint.chain_seq, 'hash', encode(v_checkpoint.row_hash, 'hex'),
      'keyId', v_checkpoint.key_id, 'signature', v_checkpoint.signature) end
  );
end;
$$;

create or replace function better_supabase.record_chain_checkpoint(
  target regclass, tenant_column text, tenant text, seq bigint, hash text, key_id text, signature text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
  v_where text := case
    when tenant_column is null then 'true'
    when tenant is null then format('t.%I is null', tenant_column)
    else format('t.%I::text = %L', tenant_column, tenant)
  end;
  v_id bigint;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role records checkpoints' using errcode = '42501', hint = 'CHAIN_FORBIDDEN';
  end if;
  execute format('select exists (select 1 from %s t where %s and t.chain_seq = $1 and t.row_hash = decode($2, ''hex''))', target, v_where)
    into v_found using seq, hash;
  if not v_found then
    raise exception 'No row has that hash at that position' using errcode = 'P0001', hint = 'CHECKPOINT_MISMATCH';
  end if;
  insert into better_supabase.chain_checkpoints (table_name, tenant, chain_seq, row_hash, key_id, signature)
  values (target::text, record_chain_checkpoint.tenant, seq, decode(hash, 'hex'), key_id, signature)
  returning id into v_id;
  return jsonb_build_object('id', v_id::text, 'tenant', record_chain_checkpoint.tenant, 'seq', seq, 'hash', hash, 'keyId', key_id, 'signature', record_chain_checkpoint.signature);
end;
$$;
revoke execute on function better_supabase.chain_heads(regclass, text) from public, anon, authenticated;
revoke execute on function better_supabase.list_chain_checkpoints(regclass, text, integer) from public, anon, authenticated;
revoke execute on function better_supabase.chain_proof(regclass, text, text, bigint) from public, anon, authenticated;
grant execute on function better_supabase.chain_heads(regclass, text) to service_role;
grant execute on function better_supabase.list_chain_checkpoints(regclass, text, integer) to service_role;
grant execute on function better_supabase.chain_proof(regclass, text, text, bigint) to service_role;
revoke execute on function better_supabase.append_only(regclass) from public, anon, authenticated;
revoke execute on function better_supabase.function_writes(regclass) from public, anon, authenticated;
revoke execute on function better_supabase.chain(regclass, text) from public, anon, authenticated;
revoke execute on function better_supabase.chain_row_hash(jsonb, bytea) from public, anon, authenticated;
revoke execute on function better_supabase.verify_chain(regclass, text, text) from public, anon, authenticated;
revoke execute on function better_supabase.record_chain_checkpoint(regclass, text, text, bigint, text, text, text) from public, anon, authenticated;
grant execute on function better_supabase.verify_chain(regclass, text, text) to service_role;
grant execute on function better_supabase.record_chain_checkpoint(regclass, text, text, bigint, text, text, text) to service_role;

-- Deletes up to batch entries older than older_than and returns how many.
-- With an audit_retention(tenant) function, each tenant keeps its own
-- interval (a plan's days, say); null falls back to the data-lifecycle
-- retention policy, then older_than. Entries under a legal hold stay. With
-- for_tenant, only entries of tenant (null: entries without one).
-- Nightly with pg_cron or the jobs drain route:
--   select better_supabase.purge_audit_log();

create or replace function better_supabase.purge_audit_log(
  older_than interval default '1 year',
  batch integer default 10000,
  tenant uuid default null,
  for_tenant boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  purged integer := 0;
  gone integer;
  v_tenant uuid;
  v_older interval;
begin
  perform set_config('better_supabase.audit_purge', 'on', true);
  if not for_tenant and to_regprocedure('"public"."audit_retention"(uuid)') is not null then
    -- One delete per tenant with that tenant's interval as a constant, so
    -- each runs on the (tenant, occurred_at) index. The tenants come from a
    -- skip scan of that index, not a scan of the log.
    for v_tenant in
      with recursive t (v) as (
        (select l."tenant_id" from "better_supabase"."audit_events" l where l."tenant_id" is not null order by l."tenant_id" limit 1)
        union all
        select (select l."tenant_id" from "better_supabase"."audit_events" l where l."tenant_id" > t.v order by l."tenant_id" limit 1)
        from t where t.v is not null
      )
      select t.v from t where t.v is not null
    loop
      exit when purged >= batch;
      continue when false;
      -- Not a literal name, so plpgsql_check passes without the hook.
      execute format('select %s($1)', to_regprocedure('"public"."audit_retention"(uuid)')::oid::regproc)
        into v_older using v_tenant;
      v_older := coalesce(v_older, older_than);
      with deleted as (
        delete from "better_supabase"."audit_events"
        where "id" in (
          select l."id" from "better_supabase"."audit_events" l
          where l."tenant_id" = v_tenant and l."occurred_at" < now() - v_older
          order by l."occurred_at"
          limit batch - purged
        )
        returning 1
      )
      select count(*)::integer into gone from deleted;
      purged := purged + gone;
    end loop;
    if purged < batch then
      with deleted as (
        delete from "better_supabase"."audit_events"
        where "id" in (
          select l."id" from "better_supabase"."audit_events" l
          where l."tenant_id" is null and l."occurred_at" < now() - older_than
          order by l."occurred_at"
          limit batch - purged
        )
        returning 1
      )
      select count(*)::integer into gone from deleted;
      purged := purged + gone;
    end if;
  else
    with deleted as (
      delete from "better_supabase"."audit_events"
      where "id" in (
        select l."id" from "better_supabase"."audit_events" l
        where l."occurred_at" < now() - older_than
          and (not for_tenant or l."tenant_id" is not distinct from purge_audit_log.tenant)
        order by l."occurred_at"
        limit greatest(batch - purged, 0)
      )
      returning 1
    )
    select purged + count(*)::integer into purged from deleted;
  end if;
  perform set_config('better_supabase.audit_purge', 'off', true);
  return purged;
end;
$$;
revoke execute on function better_supabase.purge_audit_log(interval, integer, uuid, boolean) from public, anon, authenticated;
grant execute on function better_supabase.purge_audit_log(interval, integer, uuid, boolean) to service_role;

-- Tenants with entries older than older_than, for a retention callback in TypeScript.
create or replace function better_supabase.audit_events_tenants(older_than interval default '1 day')
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct l."tenant_id" from "better_supabase"."audit_events" l
  where l."occurred_at" < now() - older_than
$$;
revoke execute on function better_supabase.audit_events_tenants(interval) from public, anon, authenticated;
grant execute on function better_supabase.audit_events_tenants(interval) to service_role;

-- A page of the entries the caller can read, newest first unless ascending:
-- the read policy decides (security invoker). Each filter takes several
-- values; search matches the event type, summary, labels, record and table.
-- Page with the last entry's occurred_at and id as cursor_at and cursor_id,
-- or open page N with skip (an offset) and count_audit_events for the total.
-- skip is ignored with a cursor, so keyset pages never scan skipped rows.

create or replace function "better_supabase"."list_audit_events"(
  for_tenants uuid[] default null,
  for_event_types text[] default null,
  for_actors uuid[] default null,
  for_target_types text[] default null,
  for_records text[] default null,
  for_categories text[] default null,
  for_outcomes text[] default null,
  search text default null,
  for_sources text[] default null,
  for_actor_kinds text[] default null,
  for_correlation_ids text[] default null,
  since timestamptz default null,
  until timestamptz default null,
  cursor_at timestamptz default null,
  cursor_id text default null,
  max_items integer default 50,
  ascending boolean default false,
  skip integer default 0,
  entry_fields text default 'full'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_where text := 'true';
  v_order text := case when ascending then 'asc' else 'desc' end;
  v_skip text := '';
  v_entry text;
  result jsonb;
begin
  -- 'summary' leaves out the old and new record, the changed columns and the
  -- metadata, so a page of a busy log stays small. get_audit_event returns the
  -- full entry.
  v_entry := case when entry_fields = 'summary'
    then $e$jsonb_build_object('id', l."id", 'table', l."table_name", 'record', l."record_id", 'op', l."op", 'actorId', l."actor_id", 'actorRole', l."actor_role", 'actorKind', l."actor_kind", 'actorLabel', l."actor_label", 'tenant', l."tenant_id", 'tenantLabel', l."tenant_label", 'occurredAt', l."occurred_at", 'impersonatedBy', l."impersonated_by", 'impersonationReason', l."impersonation_reason", 'supportSession', l."support_session_id", 'eventType', l."event_type", 'category', l."category", 'outcome', l."outcome", 'source', l."source", 'targetType', l."target_type", 'targetLabel', l."target_label") || jsonb_build_object('summary', l."summary", 'requestId', l."request_id", 'correlationId', l."correlation_id", 'scope', l."scope")$e$
    else $e$jsonb_build_object('id', l."id", 'table', l."table_name", 'record', l."record_id", 'op', l."op", 'old', l."old_record", 'new', l."new_record", 'changed', l."changed", 'actorId', l."actor_id", 'actorRole', l."actor_role", 'actorKind', l."actor_kind", 'actorLabel', l."actor_label", 'tenant', l."tenant_id", 'tenantLabel', l."tenant_label", 'occurredAt', l."occurred_at", 'impersonatedBy', l."impersonated_by", 'impersonationReason', l."impersonation_reason", 'supportSession', l."support_session_id", 'eventType', l."event_type", 'category', l."category", 'outcome', l."outcome") || jsonb_build_object('source', l."source", 'targetType', l."target_type", 'targetLabel', l."target_label", 'summary', l."summary", 'requestId', l."request_id", 'correlationId', l."correlation_id", 'scope', l."scope", 'metadata', l."metadata")$e$
  end;
  if cardinality(for_tenants) > 0 then
    v_where := v_where || $q$ and l."tenant_id" = any ($1)$q$;
  end if;
  if cardinality(for_event_types) > 0 then
    v_where := v_where || $q$ and l."event_type" = any ($2)$q$;
  end if;
  if cardinality(for_actors) > 0 then
    v_where := v_where || $q$ and l."actor_id" = any ($3)$q$;
  end if;
  if cardinality(for_target_types) > 0 then
    v_where := v_where || $q$ and l."target_type" = any ($4)$q$;
  end if;
  if cardinality(for_records) > 0 then
    v_where := v_where || $q$ and l."record_id" = any ($5)$q$;
  end if;
  if cardinality(for_categories) > 0 then
    v_where := v_where || $q$ and l."category" = any ($6)$q$;
  end if;
  if cardinality(for_outcomes) > 0 then
    v_where := v_where || $q$ and l."outcome" = any ($7)$q$;
  end if;
  if cardinality(for_sources) > 0 then
    v_where := v_where || $q$ and l."source" = any ($9)$q$;
  end if;
  if cardinality(for_actor_kinds) > 0 then
    v_where := v_where || $q$ and l."actor_kind" = any ($10)$q$;
  end if;
  if cardinality(for_correlation_ids) > 0 then
    v_where := v_where || $q$ and l."correlation_id" = any ($11)$q$;
  end if;
  if search <> '' then
    v_where := v_where || $q$ and concat_ws(' ', l."event_type", l."summary", l."target_label", l."actor_label", l."tenant_label", l."record_id", l."table_name") ilike '%' || replace(replace(replace($8, '\', '\\'), '%', '\%'), '_', '\_') || '%'$q$;
  end if;
  if since is not null then
    v_where := v_where || $q$ and l."occurred_at" >= $12$q$;
  end if;
  if until is not null then
    v_where := v_where || $q$ and l."occurred_at" < $13$q$;
  end if;
  if cursor_at is not null then
    v_where := v_where || case when ascending
      then $q$ and (l."occurred_at", l."id") > ($14, $15::bigint)$q$
      else $q$ and (l."occurred_at", l."id") < ($14, $15::bigint)$q$
    end;
  elsif coalesce(skip, 0) > 0 then
    v_skip := ' offset $17';
  end if;
  -- Only the filters passed reach the query, so the planner sees no
  -- "is null or" branches and can use the (tenant, occurred_at) index.
  execute $q$select coalesce(jsonb_agg(x.entry order by x.occurred_at $q$ || v_order || $q$, x.id $q$ || v_order || $q$), '[]')
  from (
    select $q$ || v_entry || $q$ as entry, l."occurred_at" as occurred_at, l."id" as id
    from "better_supabase"."audit_events" l
    where $q$ || v_where || $q$
    order by l."occurred_at" $q$ || v_order || $q$, l."id" $q$ || v_order || $q$
    limit $16$q$ || v_skip || $q$
  ) x$q$
  into result
  using for_tenants, for_event_types, for_actors, for_target_types, for_records, for_categories, for_outcomes, search, for_sources, for_actor_kinds, for_correlation_ids, since, until, cursor_at, cursor_id, least(greatest(coalesce(max_items, 50), 1), 1000), greatest(coalesce(skip, 0), 0);
  return result;
end;
$$;
revoke execute on function "better_supabase"."list_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamptz, timestamptz, timestamptz, text, integer, boolean, integer, text) from public, anon;
revoke execute on function "better_supabase"."list_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamptz, timestamptz, timestamptz, text, integer, boolean, integer, text) from authenticated;
grant execute on function "better_supabase"."list_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamptz, timestamptz, timestamptz, text, integer, boolean, integer, text) to service_role;
create or replace function "better_supabase"."count_audit_events"(
  for_tenants uuid[] default null,
  for_event_types text[] default null,
  for_actors uuid[] default null,
  for_target_types text[] default null,
  for_records text[] default null,
  for_categories text[] default null,
  for_outcomes text[] default null,
  search text default null,
  for_sources text[] default null,
  for_actor_kinds text[] default null,
  for_correlation_ids text[] default null,
  since timestamptz default null,
  until timestamptz default null,
  cap integer default null
)
returns bigint
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_where text := 'true';
  result bigint;
begin
  if cardinality(for_tenants) > 0 then
    v_where := v_where || $q$ and l."tenant_id" = any ($1)$q$;
  end if;
  if cardinality(for_event_types) > 0 then
    v_where := v_where || $q$ and l."event_type" = any ($2)$q$;
  end if;
  if cardinality(for_actors) > 0 then
    v_where := v_where || $q$ and l."actor_id" = any ($3)$q$;
  end if;
  if cardinality(for_target_types) > 0 then
    v_where := v_where || $q$ and l."target_type" = any ($4)$q$;
  end if;
  if cardinality(for_records) > 0 then
    v_where := v_where || $q$ and l."record_id" = any ($5)$q$;
  end if;
  if cardinality(for_categories) > 0 then
    v_where := v_where || $q$ and l."category" = any ($6)$q$;
  end if;
  if cardinality(for_outcomes) > 0 then
    v_where := v_where || $q$ and l."outcome" = any ($7)$q$;
  end if;
  if cardinality(for_sources) > 0 then
    v_where := v_where || $q$ and l."source" = any ($9)$q$;
  end if;
  if cardinality(for_actor_kinds) > 0 then
    v_where := v_where || $q$ and l."actor_kind" = any ($10)$q$;
  end if;
  if cardinality(for_correlation_ids) > 0 then
    v_where := v_where || $q$ and l."correlation_id" = any ($11)$q$;
  end if;
  if search <> '' then
    v_where := v_where || $q$ and concat_ws(' ', l."event_type", l."summary", l."target_label", l."actor_label", l."tenant_label", l."record_id", l."table_name") ilike '%' || replace(replace(replace($8, '\', '\\'), '%', '\%'), '_', '\_') || '%'$q$;
  end if;
  if since is not null then
    v_where := v_where || $q$ and l."occurred_at" >= $12$q$;
  end if;
  if until is not null then
    v_where := v_where || $q$ and l."occurred_at" < $13$q$;
  end if;
  -- With cap the count stops there: a result equal to cap means "cap or more",
  -- and a filtered view over a large log never counts every match (ADR 0425).
  execute $q$select count(*) from (select 1 from "better_supabase"."audit_events" l where $q$ || v_where
    || case when cap is null then '' else format(' limit %s', greatest(cap, 1)) end || $q$) x$q$
  into result
  using for_tenants, for_event_types, for_actors, for_target_types, for_records, for_categories, for_outcomes, search, for_sources, for_actor_kinds, for_correlation_ids, since, until;
  return result;
end;
$$;
revoke execute on function "better_supabase"."count_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamptz, timestamptz, integer) from public, anon;
revoke execute on function "better_supabase"."count_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamptz, timestamptz, integer) from authenticated;
grant execute on function "better_supabase"."count_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamptz, timestamptz, integer) to service_role;

-- One full entry by id, as list_audit_events returns it with entry_fields
-- 'full'. The read policy decides, so an entry the caller can't read is null.
create or replace function "better_supabase"."get_audit_event"(entry_id text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  result jsonb;
begin
  execute $q$select $q$ || $e$jsonb_build_object('id', l."id", 'table', l."table_name", 'record', l."record_id", 'op', l."op", 'old', l."old_record", 'new', l."new_record", 'changed', l."changed", 'actorId', l."actor_id", 'actorRole', l."actor_role", 'actorKind', l."actor_kind", 'actorLabel', l."actor_label", 'tenant', l."tenant_id", 'tenantLabel', l."tenant_label", 'occurredAt', l."occurred_at", 'impersonatedBy', l."impersonated_by", 'impersonationReason', l."impersonation_reason", 'supportSession', l."support_session_id", 'eventType', l."event_type", 'category', l."category", 'outcome', l."outcome") || jsonb_build_object('source', l."source", 'targetType', l."target_type", 'targetLabel', l."target_label", 'summary', l."summary", 'requestId', l."request_id", 'correlationId', l."correlation_id", 'scope', l."scope", 'metadata', l."metadata")$e$ || $q$ from "better_supabase"."audit_events" l where l."id" = $1$q$
  into result
  using entry_id::bigint;
  return result;
end;
$$;
revoke execute on function "better_supabase"."get_audit_event"(text) from public, anon;
revoke execute on function "better_supabase"."get_audit_event"(text) from authenticated;
grant execute on function "better_supabase"."get_audit_event"(text) to service_role;

-- The distinct event types the caller can read, found by skipping through the
-- event type index (a recursive loose scan) instead of reading every row.
create or replace function "better_supabase"."audit_event_types"(for_tenants uuid[] default null)
returns text[]
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_types text[] := '{}';
  v_next text;
begin
  -- One loose index scan per tenant: min() over the (tenant, event type) index
  -- reads one entry, where "tenant = any(...)" would read every row. Without
  -- for_tenants the scan has no tenant to lead with, so pass the tenants.
  loop
    if cardinality(for_tenants) > 0 then
      execute $q$select min(x.m) from unnest($1) t(scope_id)
        cross join lateral (select min(l."event_type") as m from "better_supabase"."audit_events" l
          where l."tenant_id" = t.scope_id and l."event_type" > $2) x$q$
      into v_next
      using for_tenants, coalesce(v_types[cardinality(v_types)], '');
    else
      execute $q$select min(l."event_type") from "better_supabase"."audit_events" l where l."event_type" > $1$q$
      into v_next
      using coalesce(v_types[cardinality(v_types)], '');
    end if;
    exit when v_next is null;
    v_types := v_types || v_next;
    exit when cardinality(v_types) >= 500;
  end loop;
  return v_types;
end;
$$;
revoke execute on function "better_supabase"."audit_event_types"(uuid[]) from public, anon;
revoke execute on function "better_supabase"."audit_event_types"(uuid[]) from authenticated;
grant execute on function "better_supabase"."audit_event_types"(uuid[]) to service_role;

-- The row changes the caller may revert, newest first, with their snapshots
-- and the target's key columns.
create or replace function "better_supabase"."audit_revert_source"(entries text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found_entries jsonb;
begin
  if cardinality(audit_revert_source.entries) > 1000 then
    raise exception 'revert at most 1000 entries at once' using errcode = '22023', hint = 'AUDIT_REVERT_TOO_MANY';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l."id"::text,
      'table', to_regclass(quote_ident(split_part(l."table_name", '.', 1)) || '.' || quote_ident(split_part(l."table_name", '.', 2)))::text,
      'op', l."op",
      'old', l."old_record",
      'new', l."new_record",
      'changed', to_jsonb(l."changed"),
      'keys', to_jsonb(coalesce(
        (select a."key_columns" from "better_supabase"."audited_tables" a where a."target" = to_regclass(quote_ident(split_part(l."table_name", '.', 1)) || '.' || quote_ident(split_part(l."table_name", '.', 2)))),
        (select array_agg(att.attname::text order by k.ord)
         from pg_catalog.pg_index i
         cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_catalog.pg_attribute att on att.attrelid = i.indrelid and att.attnum = k.attnum
         where i.indrelid = to_regclass(quote_ident(split_part(l."table_name", '.', 1)) || '.' || quote_ident(split_part(l."table_name", '.', 2))) and i.indisprimary)
      ))
    ) order by l."occurred_at" desc, l."id" desc), '[]'::jsonb)
  into found_entries
  from "better_supabase"."audit_events" l
  
  where l."id"::text = any (audit_revert_source.entries)
    and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')
      or (l."tenant_id" is not null and coalesce(better_supabase.member_can(auth.uid(), l."tenant_id", 'audit.revert'), false)));
  if jsonb_array_length(found_entries) <> cardinality(array(select distinct e from unnest(audit_revert_source.entries) e)) then
    raise exception 'an entry is missing or not yours to revert' using errcode = 'P0002', hint = 'AUDIT_ENTRY_NOT_FOUND';
  end if;
  return found_entries;
end;
$$;
revoke execute on function "better_supabase"."audit_revert_source"(text[]) from public, anon;
grant execute on function "better_supabase"."audit_revert_source"(text[]) to authenticated, service_role;

-- The entries the caller wrote under one correlation id, for the undo of a revert.
create or replace function "better_supabase"."audit_entries_correlated"(correlation text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(l."id"::text order by l."id"), '[]'::jsonb)
  from "better_supabase"."audit_events" l
  where l."correlation_id" = audit_entries_correlated.correlation
    and l."actor_id" is not distinct from auth.uid();
$$;
revoke execute on function "better_supabase"."audit_entries_correlated"(text) from public, anon;
grant execute on function "better_supabase"."audit_entries_correlated"(text) to authenticated, service_role;

-- Writes the old values of row changes back as the caller, newest entry
-- first, all or nothing.
create or replace function "better_supabase"."revert_audit_entries"(entries text[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_variable
declare
  entry jsonb;
  target regclass;
  v_old jsonb;
  v_new jsonb;
  current_row jsonb;
  columns text[];
  key_match text;
  affected integer;
  reverted integer := 0;
  v_correlation text := 'revert:' || gen_random_uuid()::text;
  v_previous text := current_setting('better_supabase.correlation_id', true);
  undo_entries jsonb := null;
begin
  perform set_config('better_supabase.correlation_id', v_correlation, true);
  for entry in select value from jsonb_array_elements("better_supabase"."audit_revert_source"(revert_audit_entries.entries)) loop
    target := (entry ->> 'table')::regclass;
    v_old := entry -> 'old';
    v_new := entry -> 'new';
    if target is null or entry ->> 'op' not in ('insert', 'update', 'delete') or jsonb_typeof(entry -> 'keys') <> 'array' then
      raise exception 'the entry is not a row change of a table that still exists' using errcode = '22023', hint = 'AUDIT_ENTRY_NOT_REVERTIBLE';
    end if;
    select string_agg(format('t.%I::text is not distinct from %L', k, coalesce(v_new, v_old) ->> k), ' and ')
    into key_match
    from jsonb_array_elements_text(entry -> 'keys') k;
    execute format('select to_jsonb(t) from %s t where %s', target, key_match) into current_row;
    case entry ->> 'op'
      when 'update' then
        select array_agg(k) into columns
        from jsonb_array_elements_text(coalesce(entry -> 'changed', (select jsonb_agg(n) from jsonb_object_keys(v_new) n))) k
        where v_new ? k and v_old ? k;
        if columns is null then
          raise exception 'the entry changed no column it can restore' using errcode = '22023', hint = 'AUDIT_ENTRY_NOT_REVERTIBLE';
        end if;
        if exists (select 1 from unnest(columns) k where v_old -> k = '"[redacted]"'::jsonb or v_new -> k = '"[redacted]"'::jsonb) then
          raise exception 'the entry holds redacted values' using errcode = '22023', hint = 'AUDIT_ENTRY_REDACTED';
        end if;
        if current_row is null or exists (
          select 1 from unnest(columns) k where current_row -> k is distinct from v_new -> k
        ) then
          raise exception 'the row changed after this entry' using errcode = 'P0001', hint = 'ROW_CHANGED_SINCE';
        end if;
        execute format(
          'update %s t set %s from jsonb_populate_record(null::%s, $1) o where %s',
          target,
          (select string_agg(format('%I = o.%I', k, k), ', ') from unnest(columns) k),
          target,
          key_match
        ) using v_old;
      when 'insert' then
        if current_row is null or exists (
          select 1 from jsonb_each(v_new) n
          where n.value <> '"[redacted]"'::jsonb and current_row -> n.key is distinct from n.value
        ) then
          raise exception 'the row changed after this entry' using errcode = 'P0001', hint = 'ROW_CHANGED_SINCE';
        end if;
        execute format('delete from %s t where %s', target, key_match);
      when 'delete' then
        if current_row is not null then
          raise exception 'a row with this key exists again' using errcode = 'P0001', hint = 'ROW_CHANGED_SINCE';
        end if;
        if exists (select 1 from jsonb_each(v_old) o where o.value = '"[redacted]"'::jsonb) then
          raise exception 'the entry holds redacted values' using errcode = '22023', hint = 'AUDIT_ENTRY_REDACTED';
        end if;
        select array_agg(att.attname::text order by att.attnum) into columns
        from pg_catalog.pg_attribute att
        where att.attrelid = target and att.attnum > 0 and not att.attisdropped
          and att.attgenerated = '' and v_old ? att.attname::text;
        execute format(
          'insert into %s (%s) overriding system value select %s from jsonb_populate_record(null::%s, $1) o',
          target,
          (select string_agg(format('%I', k), ', ') from unnest(columns) k),
          (select string_agg(format('o.%I', k), ', ') from unnest(columns) k),
          target
        ) using v_old;
    end case;
    get diagnostics affected = row_count;
    if affected <> 1 then
      raise exception 'not allowed to change this row' using errcode = '42501', hint = 'AUDIT_REVERT_FORBIDDEN';
    end if;
    reverted := reverted + 1;
  end loop;
  perform set_config('better_supabase.correlation_id', coalesce(v_previous, ''), true);
  undo_entries := "better_supabase"."audit_entries_correlated"(v_correlation);
  return jsonb_build_object('reverted', reverted, 'entries', undo_entries);
end;
$$;
revoke execute on function "better_supabase"."revert_audit_entries"(text[]) from public, anon;
grant execute on function "better_supabase"."revert_audit_entries"(text[]) to authenticated, service_role;
