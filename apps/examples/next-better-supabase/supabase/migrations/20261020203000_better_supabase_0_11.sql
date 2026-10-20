-- better-supabase 0.11.0 audit module: acting_member() for admin({}, { as }), tenant_path and tenant_function on audit(), and an update trigger that skips ignored columns.
SET local check_function_bodies = off;

create or replace function better_supabase.acting_member()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  header text;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    return null;
  end if;
  header := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-bs-actor';
  return case when header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then header::uuid end;
exception when others then
  return null;
end;
$$;
grant execute on function better_supabase.acting_member() to anon, authenticated, service_role;

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
  path_value text;
  path_step jsonb;
begin
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
    select coalesce(a.ignore, '{}') as ignore, coalesce(a.key_columns, '{id}') as key_columns,
      coalesce(a.redact, '{}') as redact, a.category, a.event_prefix, a.target_type, a.tenant_column,
      a.label_column, null::jsonb as tenant_path, null::text as tenant_function
    into entry
    from (select 1) one
    left join better_supabase.audited_tables a on a.target = tg_relid::regclass;
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
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "organization_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
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

drop function if exists better_supabase.audit(regclass, text[], boolean, text[], text, text, text, text, text);

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
  tenant_function regprocedure default null
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
begin
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
    target, 'bs_audit', 'audit', replace_trigger
  );
  select array_agg(c.attname::text order by k.ord) into keys
  from pg_catalog.pg_index i
  cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
  join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
  where i.indrelid = audit.target and i.indisprimary;
  delete from better_supabase.audited_tables a where a.target = audit.target;
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
  execute format('drop trigger if exists bs_audit on %s', target);
  execute format('drop trigger if exists bs_audit_update on %s', target);
  if cardinality(coalesce(audit.ignore, '{}')) > 0 then
    execute format(
      'create trigger bs_audit after insert or delete on %s for each row execute function better_supabase.audit_row_change(%L)',
      target, base_settings::text
    );
    execute format(
      'create trigger bs_audit_update after update on %s for each row when ((to_jsonb(old) - %L::text[]) is distinct from (to_jsonb(new) - %L::text[])) execute function better_supabase.audit_row_change(%L)',
      target, audit.ignore, audit.ignore, base_settings::text
    );
  else
    execute format(
      'create trigger bs_audit after insert or update or delete on %s for each row execute function better_supabase.audit_row_change(%L)',
      target, base_settings::text
    );
  end if;
end;
$$;

create or replace function better_supabase.unaudit(target regclass)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists bs_audit on %s', target);
  execute format('drop trigger if exists bs_audit_update on %s', target);
  delete from better_supabase.audited_tables a where a.target = unaudit.target;
end;
$$;

revoke execute on function better_supabase.audit(regclass, text[], boolean, text[], text, text, text, text, text, text, regprocedure) from public, anon, authenticated;
revoke execute on function better_supabase.unaudit(regclass) from public, anon, authenticated;

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
  entry_id "better_supabase"."audit_events"."id"%type;
begin
  if restricted is not null or ip is not null or user_agent is not null or session_id is not null then
    raise exception 'audit_event got restricted details, and the audit module has no restricted table'
      using errcode = '22023', hint = 'Set blocks.audit.options.restricted to true.';
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
      and l."organization_id" is not distinct from audit_event.tenant
    limit 1;
    if existing is not null then
      return existing;
    end if;
  end if;
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "organization_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
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
  return entry_id::text;
end;
$$;
revoke execute on function better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) to "service_role";
