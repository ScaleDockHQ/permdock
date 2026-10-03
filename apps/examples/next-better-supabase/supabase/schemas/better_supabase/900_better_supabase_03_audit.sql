-- better-supabase SQL kit: audit (0.4.0)
-- Records inserts, updates and deletes with the actor and changed columns, for tables you register.
-- Managed by `better-supabase sql add`; re-running it overwrites this file.

create schema if not exists better_supabase;
grant usage on schema better_supabase to anon, authenticated, service_role;

create table if not exists better_supabase.audited_tables (
  target regclass primary key,
  ignore text[] not null default '{}'
);

create table if not exists better_supabase.audit_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_id text,
  op text not null check (op in ('insert', 'update', 'delete')),
  old_record jsonb,
  new_record jsonb,
  changed text[],
  actor_id uuid,
  actor_role text,
  org_id uuid,
  at timestamptz not null default now()
);
-- Set when an admin acted as the user (the act claim).
alter table better_supabase.audit_log add column if not exists impersonated_by uuid;
alter table better_supabase.audit_log add column if not exists impersonation_reason text;
create index if not exists audit_log_record_idx on better_supabase.audit_log (table_name, record_id, at desc);
create index if not exists audit_log_org_idx on better_supabase.audit_log (org_id, at desc);

alter table better_supabase.audited_tables enable row level security;
alter table better_supabase.audit_log enable row level security;
revoke all on better_supabase.audited_tables, better_supabase.audit_log from anon, authenticated;
grant select on better_supabase.audit_log to service_role;

create or replace function better_supabase.audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ignored text[];
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  row_data jsonb := coalesce(new_row, old_row);
  changed_columns text[];
begin
  select a.ignore into ignored
  from better_supabase.audited_tables a
  where a.target = tg_relid::regclass;
  ignored := coalesce(ignored, '{}');
  old_row := old_row - ignored;
  new_row := new_row - ignored;
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into changed_columns
    from jsonb_each(new_row) n
    where n.value is distinct from old_row -> n.key;
    if changed_columns is null then
      return null;
    end if;
  end if;
  insert into better_supabase.audit_log
    (table_name, record_id, op, old_record, new_record, changed, actor_id, actor_role, org_id,
     impersonated_by, impersonation_reason)
  values (
    tg_table_schema || '.' || tg_table_name,
    row_data ->> 'id',
    lower(tg_op),
    old_row,
    new_row,
    changed_columns,
    auth.uid(),
    coalesce(auth.jwt() ->> 'role', current_user),
    case
      when row_data ->> 'organization_id' ~ '^[0-9a-f-]{36}$'
        then (row_data ->> 'organization_id')::uuid
    end,
    case
      when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$'
        then (auth.jwt() -> 'act' ->> 'sub')::uuid
    end,
    auth.jwt() -> 'act' ->> 'reason'
  );
  return null;
end;
$$;

-- select better_supabase.audit('public.customers', ignore => '{updated_at}');
create or replace function better_supabase.audit(target regclass, ignore text[] default '{}')
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into better_supabase.audited_tables as a (target, ignore) values (audit.target, audit.ignore)
  on conflict on constraint audited_tables_pkey do update set ignore = excluded.ignore;
  execute format('drop trigger if exists bs_audit on %s', target);
  execute format(
    'create trigger bs_audit after insert or update or delete on %s for each row execute function better_supabase.audit_trigger()',
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

-- Deletes up to batch entries older than older_than and returns how many.
-- Ids grow with time, so the primary key finds the oldest rows first.
-- Nightly with pg_cron: select cron.schedule('purge-audit-log', '15 3 * * *', 'select better_supabase.purge_audit_log()');
create or replace function better_supabase.purge_audit_log(
  older_than interval default '1 year',
  batch integer default 10000
)
returns integer
language sql
set search_path = ''
as $$
  with purged as (
    delete from better_supabase.audit_log
    where id in (
      select l.id from better_supabase.audit_log l
      where l.at < now() - older_than
      order by l.id
      limit batch
    )
    returning 1
  )
  select count(*)::integer from purged
$$;
revoke execute on function better_supabase.purge_audit_log(interval, integer) from public, anon, authenticated;
grant execute on function better_supabase.purge_audit_log(interval, integer) to service_role;
