-- better-supabase SQL kit: audit (0.5.1)
-- @bs-kit audit@2 managed
-- Records inserts, updates and deletes with the actor and changed columns for tables you register, plus semantic events through audit_event(), with redaction, an append-only guard, a tenant read policy and per-tenant retention as options.
-- Managed by `better-supabase sql add`; re-running it overwrites this file.
-- Change it through `kits` in better-supabase.config.ts and the module's SQL hooks.

create schema if not exists better_supabase;
grant usage on schema better_supabase to anon, authenticated, service_role;

create table if not exists better_supabase.audited_tables (
  target regclass primary key,
  ignore text[] not null default '{}'
);
-- The primary key columns, read when the table is registered; composite keys are joined with ','.
alter table better_supabase.audited_tables add column if not exists key_columns text[] not null default '{id}';
-- Per-table event naming and redaction.
alter table better_supabase.audited_tables add column if not exists redact text[] not null default '{}';
alter table better_supabase.audited_tables add column if not exists category text;
alter table better_supabase.audited_tables add column if not exists event_prefix text;
alter table better_supabase.audited_tables add column if not exists target_type text;
alter table better_supabase.audited_tables add column if not exists tenant_column text;
alter table better_supabase.audited_tables enable row level security;
revoke all on better_supabase.audited_tables from anon, authenticated;

-- The client address the API gateway appended to x-forwarded-for (the
-- right-most hop; clients can forge the ones before it), or null.
create or replace function better_supabase.request_ip()
returns inet
language plpgsql
stable
set search_path = ''
as $$
begin
  return nullif(trim(reverse(split_part(reverse(current_setting('request.headers', true)::json ->> 'x-forwarded-for'), ',', 1))), '')::inet;
exception when others then
  return null;
end;
$$;

create table if not exists "better_supabase"."audit_events" (
  "id" bigint generated always as identity primary key,
  "table_name" text,
  "record_id" text,
  "op" text not null,
  "old_record" jsonb,
  "new_record" jsonb,
  "changed" text[],
  "actor_id" uuid,
  "actor_role" text,
  "organization_id" uuid,
  "occurred_at" timestamptz not null default now()
);
alter table "better_supabase"."audit_events" drop constraint if exists audit_log_op_check;
alter table "better_supabase"."audit_events" drop constraint if exists bs_audit_op_check;
alter table "better_supabase"."audit_events" add constraint bs_audit_op_check check ("op" in ('insert', 'update', 'delete', 'event'));
alter table "better_supabase"."audit_events" alter column "table_name" drop not null;
-- Set when an admin acted as the user (the act claim).
alter table "better_supabase"."audit_events" add column if not exists "impersonated_by" uuid;
alter table "better_supabase"."audit_events" add column if not exists "impersonation_reason" text;
alter table "better_supabase"."audit_events" add column if not exists "support_session_id" uuid;
-- Semantic events (audit_event) and the per-table registry fill these.
alter table "better_supabase"."audit_events" add column if not exists "event_type" text;
alter table "better_supabase"."audit_events" add column if not exists "category" text;
alter table "better_supabase"."audit_events" add column if not exists "outcome" text;
alter table "better_supabase"."audit_events" add column if not exists "source" text;
alter table "better_supabase"."audit_events" add column if not exists "target_type" text;
alter table "better_supabase"."audit_events" add column if not exists "metadata" jsonb;
alter table "better_supabase"."audit_events" add column if not exists "idempotency_key" text;
create index if not exists audit_events_record_idx on "better_supabase"."audit_events" ("table_name", "record_id", "occurred_at" desc);
create index if not exists audit_events_organization_idx on "better_supabase"."audit_events" ("organization_id", "occurred_at" desc);
create index if not exists audit_events_occurred_at_idx on "better_supabase"."audit_events" ("occurred_at");
create unique index if not exists audit_events_idempotency_idx on "better_supabase"."audit_events" ("idempotency_key", "organization_id") nulls not distinct where "idempotency_key" is not null;
alter table "better_supabase"."audit_events" enable row level security;
revoke all on "better_supabase"."audit_events" from anon, authenticated;
grant select on "better_supabase"."audit_events" to service_role;

create or replace function better_supabase.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entry record;
  entry_id "better_supabase"."audit_events"."id"%type;
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  row_data jsonb := coalesce(new_row, old_row);
  changed_columns text[];
begin
  select coalesce(a.ignore, '{}') as ignore, coalesce(a.key_columns, '{id}') as key_columns,
    coalesce(a.redact, '{}') as redact, a.category, a.event_prefix, a.target_type, a.tenant_column
  into entry
  from (select 1) one
  left join better_supabase.audited_tables a on a.target = tg_relid::regclass;
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
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "organization_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type")
  values (
    tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    lower(tg_op),
    old_row,
    new_row,
    changed_columns,
    auth.uid(),
    coalesce(auth.jwt() ->> 'role', current_user),
    case when row_data ->> coalesce(entry.tenant_column, 'organization_id') ~ '^[0-9a-f-]{36}$' then (row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end,
    case when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'sub')::uuid end,
    auth.jwt() -> 'act' ->> 'reason',
    case when auth.jwt() -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name)
  )
  returning "id" into entry_id;
  return null;
end;
$$;

create or replace function better_supabase.replace_equivalent_triggers(
  target regclass,
  kit_trigger text,
  pattern text,
  replace_trigger boolean
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  found record;
begin
  for found in
    select t.tgname as name, p.proname as fn
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = replace_equivalent_triggers.target
      and not t.tgisinternal
      and t.tgname <> replace_equivalent_triggers.kit_trigger
      and p.proname ~* replace_equivalent_triggers.pattern
  loop
    if replace_trigger then
      execute format('drop trigger %I on %s', found.name, target);
    else
      raise warning '% already has trigger % (%), which does what % does. Pass replace_trigger => true to drop it.',
        target, found.name, found.fn, kit_trigger;
    end if;
  end loop;
end;
$$;
revoke execute on function better_supabase.replace_equivalent_triggers(regclass, text, text, boolean) from public, anon, authenticated;

drop function if exists better_supabase.audit(regclass, text[]);
drop function if exists better_supabase.audit(regclass, text[], boolean);

-- select better_supabase.audit('public.customers', ignore => '{updated_at}');
-- redact => '{api_key}' masks values but keeps them in changed;
-- event_prefix, category and target_type name the entries (event_prefix.created);
-- tenant_column overrides the module's tenant column for this table.
-- replace_trigger => true drops another audit trigger on the table.
create or replace function better_supabase.audit(
  target regclass,
  ignore text[] default '{}',
  replace_trigger boolean default false,
  redact text[] default '{}',
  category text default null,
  event_prefix text default null,
  target_type text default null,
  tenant_column text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  keys text[];
begin
  perform better_supabase.replace_equivalent_triggers(
    target, 'bs_audit', 'audit', replace_trigger
  );
  select array_agg(c.attname::text order by k.ord) into keys
  from pg_catalog.pg_index i
  cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
  join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
  where i.indrelid = audit.target and i.indisprimary;
  insert into better_supabase.audited_tables as a
    (target, ignore, key_columns, redact, category, event_prefix, target_type, tenant_column)
  values (
    audit.target, audit.ignore, coalesce(keys, '{id}'), audit.redact, audit.category,
    audit.event_prefix, audit.target_type, audit.tenant_column
  )
  on conflict on constraint audited_tables_pkey do update
    set ignore = excluded.ignore, key_columns = excluded.key_columns, redact = excluded.redact,
      category = excluded.category, event_prefix = excluded.event_prefix,
      target_type = excluded.target_type, tenant_column = excluded.tenant_column;
  execute format('drop trigger if exists bs_audit on %s', target);
  execute format(
    'create trigger bs_audit after insert or update or delete on %s for each row execute function better_supabase.audit_row_change()',
    target
  );
end;
$$;

create or replace function better_supabase.unaudit(target regclass)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists bs_audit on %s', target);
  delete from better_supabase.audited_tables a where a.target = unaudit.target;
end;
$$;

revoke execute on function better_supabase.audit(regclass, text[], boolean, text[], text, text, text, text) from public, anon, authenticated;
revoke execute on function better_supabase.unaudit(regclass) from public, anon, authenticated;

-- Records a semantic app event (invoice.sent, member.invited) next to the
-- row changes. A repeated idempotency_key returns the first entry's id.
-- actor_id is honoured for the service role and direct admin connections;
-- everyone else is auth.uid().
drop function if exists better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid);
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
  actor_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing text;
  entry_id "better_supabase"."audit_events"."id"%type;
begin
  if not (coalesce(nullif(auth.jwt() ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) or actor_id is null then
    actor_id := auth.uid();
  end if;
  if idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('better_supabase.audit_event'), pg_catalog.hashtext(coalesce(tenant::text, '') || ':' || idempotency_key));
    select l."id"::text into existing
    from "better_supabase"."audit_events" l
    where l."idempotency_key" = audit_event.idempotency_key
      and l."organization_id" is not distinct from audit_event.tenant
    limit 1;
    if existing is not null then
      return existing;
    end if;
  end if;
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "organization_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key")
  values (
    null,
    record_id,
    'event',
    actor_id,
    coalesce(auth.jwt() ->> 'role', current_user),
    tenant,
    case when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'sub')::uuid end,
    auth.jwt() -> 'act' ->> 'reason',
    case when auth.jwt() -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'session_id')::uuid end,
    event_type,
    coalesce(category, 'system'),
    coalesce(outcome, 'success'),
    coalesce(source, 'app'),
    target_type,
    coalesce(metadata, '{}'),
    idempotency_key
  )
  returning "id" into entry_id;
  return entry_id::text;
end;
$$;
revoke execute on function better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid) to "service_role";

-- Entries are append-only. purge_audit_log deletes old ones: it runs as its
-- owner and sets better_supabase.audit_purge, and a role that only sets the
-- setting is not the owner.
create or replace function better_supabase.audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_setting('better_supabase.audit_purge', true) = 'on'
    and current_user = (
      select r.rolname from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where p.oid = to_regprocedure('better_supabase.purge_audit_log(interval, integer, uuid, boolean)')
    )
  then
    return old;
  end if;
  raise exception 'audit log entries are append-only'
    using errcode = '42501', hint = 'Delete old entries with better_supabase.purge_audit_log()';
end;
$$;
revoke execute on function better_supabase.audit_append_only() from public, anon, authenticated;
drop trigger if exists "bs_audit_append_only" on "better_supabase"."audit_events";
create trigger "bs_audit_append_only" before update or delete on "better_supabase"."audit_events"
  for each row execute function better_supabase.audit_append_only();
drop trigger if exists "bs_audit_no_truncate" on "better_supabase"."audit_events";
create trigger "bs_audit_no_truncate" before truncate on "better_supabase"."audit_events"
  for each statement execute function better_supabase.audit_append_only();

drop policy if exists bs_audit_read on "better_supabase"."audit_events";
drop function if exists "better_supabase"."audit_read_tenants"();
drop function if exists "better_supabase"."audit_reads_all"();

-- Deletes up to batch entries older than older_than and returns how many.
-- With an audit_retention(tenant) function, each tenant keeps its own
-- interval (a plan's days, say); null falls back to older_than. With
-- for_tenant, only entries of tenant (null: entries without one).
-- Nightly with pg_cron or the jobs drain route:
--   select better_supabase.purge_audit_log();
drop function if exists better_supabase.purge_audit_log(interval, integer);
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
  purged integer;
begin
  perform set_config('better_supabase.audit_purge', 'on', true);
  if not for_tenant and to_regprocedure('"public"."audit_retention"(uuid)') is not null then
    with gone as (
      delete from "better_supabase"."audit_events"
      where "id" in (
        select l."id" from "better_supabase"."audit_events" l
        where l."occurred_at" < now() - coalesce("public"."audit_retention"(l."organization_id"), older_than)
        order by l."occurred_at"
        limit batch
      )
      returning 1
    )
    select count(*)::integer into purged from gone;
  else
    with gone as (
      delete from "better_supabase"."audit_events"
      where "id" in (
        select l."id" from "better_supabase"."audit_events" l
        where l."occurred_at" < now() - older_than
          and (not for_tenant or l."organization_id" is not distinct from purge_audit_log.tenant)
        order by l."occurred_at"
        limit batch
      )
      returning 1
    )
    select count(*)::integer into purged from gone;
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
  select distinct l."organization_id" from "better_supabase"."audit_events" l
  where l."occurred_at" < now() - older_than
$$;
revoke execute on function better_supabase.audit_events_tenants(interval) from public, anon, authenticated;
grant execute on function better_supabase.audit_events_tenants(interval) to service_role;

-- Deprecated since 0.5.0: use better_supabase.audit_events (occurred_at, organization_id).
create or replace view "better_supabase".audit_log
  with (security_invoker = true) as
  select l.*, l."occurred_at" as at, l."organization_id" as org_id
  from "better_supabase"."audit_events" l;
comment on view "better_supabase".audit_log is 'deprecated: use better_supabase.audit_events';
revoke all on "better_supabase".audit_log from anon, authenticated;
grant select on "better_supabase".audit_log to service_role;

create schema if not exists better_supabase;
create table if not exists better_supabase.kit_modules (
  name text primary key,
  version integer not null,
  mode text not null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table better_supabase.kit_modules enable row level security;
revoke all on better_supabase.kit_modules from anon, authenticated;
grant select on better_supabase.kit_modules to service_role;
