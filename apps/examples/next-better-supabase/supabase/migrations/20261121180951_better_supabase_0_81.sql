SET local check_function_bodies = off;

DROP FUNCTION
  "better_supabase"."audit_event"(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text);

DROP FUNCTION
  "better_supabase"."audit_event_trusted"(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid,
  uuid, text);

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "summary_key" text;

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "summary_params" jsonb;

CREATE OR REPLACE FUNCTION better_supabase.audit (
  target          regclass,
  ignore          text[]       DEFAULT '{}'::text[],
  replace_trigger boolean      DEFAULT false,
  redact          text[]       DEFAULT '{}'::text[],
  category        text         DEFAULT NULL::text,
  event_prefix    text         DEFAULT NULL::text,
  target_type     text         DEFAULT NULL::text,
  tenant_column   text         DEFAULT NULL::text,
  label_column    text         DEFAULT NULL::text,
  tenant_path     text         DEFAULT NULL::text,
  tenant_function regprocedure DEFAULT NULL::regprocedure,
  deferred        boolean      DEFAULT false,
  statement       boolean      DEFAULT false,
  archive_column  text         DEFAULT NULL::text,
  archive_value   text         DEFAULT NULL::text
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
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
    'tenant_function', audit.tenant_function::text,
    'archive_column', audit.archive_column,
    'archive_value', audit.archive_value
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event (
  event_type           text,
  category             text  DEFAULT NULL::text,
  outcome              text  DEFAULT 'success'::text,
  source               text  DEFAULT NULL::text,
  target_type          text  DEFAULT NULL::text,
  record_id            text  DEFAULT NULL::text,
  tenant               uuid  DEFAULT NULL::uuid,
  metadata             jsonb DEFAULT '{}'::jsonb,
  idempotency_key      text  DEFAULT NULL::text,
  restricted           jsonb DEFAULT NULL::jsonb,
  actor_id             uuid  DEFAULT NULL::uuid,
  summary              text  DEFAULT NULL::text,
  target_label         text  DEFAULT NULL::text,
  correlation_id       text  DEFAULT NULL::text,
  actor_kind           text  DEFAULT NULL::text,
  actor_label          text  DEFAULT NULL::text,
  ip                   inet  DEFAULT NULL::inet,
  user_agent           text  DEFAULT NULL::text,
  session_id           text  DEFAULT NULL::text,
  request_id           text  DEFAULT NULL::text,
  scope                text  DEFAULT NULL::text,
  support_session      uuid  DEFAULT NULL::uuid,
  impersonated_by      uuid  DEFAULT NULL::uuid,
  impersonation_reason text  DEFAULT NULL::text,
  summary_key          text  DEFAULT NULL::text,
  summary_params       jsonb DEFAULT NULL::jsonb
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
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
    coalesce(summary_key, event_type),
    summary_params,
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event_many (
  events jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
        impersonation_reason => batch_event ->> 'impersonation_reason',
        summary_key => batch_event ->> 'summary_key',
        summary_params => nullif(batch_event -> 'summary_params', 'null'::jsonb)
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event_trusted (
  event_type           text,
  category             text  DEFAULT NULL::text,
  outcome              text  DEFAULT 'success'::text,
  source               text  DEFAULT NULL::text,
  target_type          text  DEFAULT NULL::text,
  record_id            text  DEFAULT NULL::text,
  tenant               uuid  DEFAULT NULL::uuid,
  metadata             jsonb DEFAULT '{}'::jsonb,
  idempotency_key      text  DEFAULT NULL::text,
  restricted           jsonb DEFAULT NULL::jsonb,
  actor_id             uuid  DEFAULT NULL::uuid,
  summary              text  DEFAULT NULL::text,
  target_label         text  DEFAULT NULL::text,
  correlation_id       text  DEFAULT NULL::text,
  actor_kind           text  DEFAULT NULL::text,
  actor_label          text  DEFAULT NULL::text,
  ip                   inet  DEFAULT NULL::inet,
  user_agent           text  DEFAULT NULL::text,
  session_id           text  DEFAULT NULL::text,
  request_id           text  DEFAULT NULL::text,
  scope                text  DEFAULT NULL::text,
  support_session      uuid  DEFAULT NULL::uuid,
  impersonated_by      uuid  DEFAULT NULL::uuid,
  impersonation_reason text  DEFAULT NULL::text,
  summary_key          text  DEFAULT NULL::text,
  summary_params       jsonb DEFAULT NULL::jsonb
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
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
    coalesce(summary_key, event_type),
    summary_params,
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_row_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
      settings -> 'tenant_path' as tenant_path, settings ->> 'tenant_function' as tenant_function,
      settings ->> 'archive_column' as archive_column, settings ->> 'archive_value' as archive_value
    into entry;
  else
    select coalesce(a."ignore", '{}') as ignore, coalesce(a."key_columns", '{id}') as key_columns,
      coalesce(a."redact", '{}') as redact, a."category" as category,
      a."event_prefix" as event_prefix, a."target_type" as target_type,
      a."tenant_column" as tenant_column, a."label_column" as label_column,
      null::jsonb as tenant_path, null::text as tenant_function,
      null::text as archive_column, null::text as archive_value
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
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
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
    coalesce(entry.event_prefix, tg_table_name) || '.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then case when entry.archive_column is null then 'updated' when (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'archived' when (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'restored' else 'updated' end else 'deleted' end,
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
    null,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
  )
  returning "id" into entry_id;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_statement_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
      settings -> 'tenant_path' as tenant_path, settings ->> 'tenant_function' as tenant_function,
      settings ->> 'archive_column' as archive_column, settings ->> 'archive_value' as archive_value
    into entry;
  else
    select coalesce(a."ignore", '{}') as ignore, coalesce(a."key_columns", '{id}') as key_columns,
      coalesce(a."redact", '{}') as redact, a."category" as category,
      a."event_prefix" as event_prefix, a."target_type" as target_type,
      a."tenant_column" as tenant_column, a."label_column" as label_column,
      null::jsonb as tenant_path, null::text as tenant_function,
      null::text as archive_column, null::text as archive_value
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
    insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
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
    coalesce(entry.event_prefix, tg_table_name) || '.' || case op when 'insert' then 'created' when 'update' then case when entry.archive_column is null then 'updated' when (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'archived' when (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'restored' else 'updated' end else 'deleted' end,
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
    null,
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
    insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
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
    coalesce(entry.event_prefix, tg_table_name) || '.' || case op when 'insert' then 'created' when 'update' then case when entry.archive_column is null then 'updated' when (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'archived' when (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'restored' else 'updated' end else 'deleted' end,
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
    null,
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
    insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
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
    coalesce(entry.event_prefix, tg_table_name) || '.' || case op when 'insert' then 'created' when 'update' then case when entry.archive_column is null then 'updated' when (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'archived' when (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'restored' else 'updated' end else 'deleted' end,
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
    null,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
    from final;
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_audit_event (
  entry_id text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  result jsonb;
begin
  execute $q$select $q$ || $e$jsonb_build_object('id', l."id", 'table', l."table_name", 'record', l."record_id", 'op', l."op", 'old', l."old_record", 'new', l."new_record", 'changed', l."changed", 'actorId', l."actor_id", 'actorRole', l."actor_role", 'actorKind', l."actor_kind", 'actorLabel', l."actor_label", 'tenant', l."tenant_id", 'tenantLabel', l."tenant_label", 'occurredAt', l."occurred_at", 'impersonatedBy', l."impersonated_by", 'impersonationReason', l."impersonation_reason", 'supportSession', l."support_session_id", 'eventType', l."event_type", 'category', l."category", 'outcome', l."outcome") || jsonb_build_object('source', l."source", 'targetType', l."target_type", 'targetLabel', l."target_label", 'summary', l."summary", 'summaryKey', l."summary_key", 'summaryParams', l."summary_params", 'requestId', l."request_id", 'correlationId', l."correlation_id", 'scope', l."scope", 'metadata', l."metadata")$e$ || $q$ from "better_supabase"."audit_events" l where l."id" = $1$q$
  into result
  using entry_id::bigint;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.is_service_role()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$ select coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') $function$;

CREATE OR REPLACE FUNCTION better_supabase.list_audit_events (
  for_tenants         uuid[]                   DEFAULT NULL::uuid[],
  for_event_types     text[]                   DEFAULT NULL::text[],
  for_actors          uuid[]                   DEFAULT NULL::uuid[],
  for_target_types    text[]                   DEFAULT NULL::text[],
  for_records         text[]                   DEFAULT NULL::text[],
  for_categories      text[]                   DEFAULT NULL::text[],
  for_outcomes        text[]                   DEFAULT NULL::text[],
  search              text                     DEFAULT NULL::text,
  for_sources         text[]                   DEFAULT NULL::text[],
  for_actor_kinds     text[]                   DEFAULT NULL::text[],
  for_correlation_ids text[]                   DEFAULT NULL::text[],
  since               timestamp with time zone DEFAULT NULL::timestamp WITH time zone,
  until               timestamp with time zone DEFAULT NULL::timestamp WITH time zone,
  cursor_at           timestamp with time zone DEFAULT NULL::timestamp WITH time zone,
  cursor_id           text                     DEFAULT NULL::text,
  max_items           integer                  DEFAULT 50,
  ascending           boolean                  DEFAULT false,
  skip                integer                  DEFAULT 0,
  entry_fields        text                     DEFAULT 'full'::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
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
    then $e$jsonb_build_object('id', l."id", 'table', l."table_name", 'record', l."record_id", 'op', l."op", 'actorId', l."actor_id", 'actorRole', l."actor_role", 'actorKind', l."actor_kind", 'actorLabel', l."actor_label", 'tenant', l."tenant_id", 'tenantLabel', l."tenant_label", 'occurredAt', l."occurred_at", 'impersonatedBy', l."impersonated_by", 'impersonationReason', l."impersonation_reason", 'supportSession', l."support_session_id", 'eventType', l."event_type", 'category', l."category", 'outcome', l."outcome", 'source', l."source", 'targetType', l."target_type", 'targetLabel', l."target_label") || jsonb_build_object('summary', l."summary", 'summaryKey', l."summary_key", 'summaryParams', l."summary_params", 'requestId', l."request_id", 'correlationId', l."correlation_id", 'scope', l."scope")$e$
    else $e$jsonb_build_object('id', l."id", 'table', l."table_name", 'record', l."record_id", 'op', l."op", 'old', l."old_record", 'new', l."new_record", 'changed', l."changed", 'actorId', l."actor_id", 'actorRole', l."actor_role", 'actorKind', l."actor_kind", 'actorLabel', l."actor_label", 'tenant', l."tenant_id", 'tenantLabel', l."tenant_label", 'occurredAt', l."occurred_at", 'impersonatedBy', l."impersonated_by", 'impersonationReason', l."impersonation_reason", 'supportSession', l."support_session_id", 'eventType', l."event_type", 'category', l."category", 'outcome', l."outcome") || jsonb_build_object('source', l."source", 'targetType', l."target_type", 'targetLabel', l."target_label", 'summary', l."summary", 'summaryKey', l."summary_key", 'summaryParams', l."summary_params", 'requestId', l."request_id", 'correlationId', l."correlation_id", 'scope', l."scope", 'metadata', l."metadata")$e$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.row_visible (
  rel        regclass,
  key_column name,
  key_value  anyelement
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_role name := coalesce(nullif(current_setting('role', true), 'none'), nullif((select auth.jwt()) ->> 'role', ''), session_user);
  v_using text;
  v_found boolean;
begin
  if not has_table_privilege(v_role, rel, 'select') then
    return false;
  end if;
  if coalesce((select r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = v_role), false)
    or not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = rel) then
    v_using := 'true';
  else
    select '(' || coalesce(string_agg('(' || coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), 'true') || ')', ' or ') filter (where p.polpermissive), 'false') || ')'
        || coalesce(' and ' || string_agg('(' || coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), 'true') || ')', ' and ') filter (where not p.polpermissive), '')
      into v_using
    from pg_catalog.pg_policy p
    where p.polrelid = rel
      and p.polcmd in ('r', '*')
      and (0::oid = any (p.polroles) or exists (select 1 from unnest(p.polroles) o where pg_catalog.pg_has_role(v_role, o, 'usage')));
  end if;
  execute format('select exists (select 1 from %s where %I = $1 and (%s))', rel, key_column, v_using)
    into v_found using key_value;
  return coalesce(v_found, false);
exception when others then
  return false;
end;
$function$;

REVOKE ALL ON FUNCTION "better_supabase"."audit"(regclass, text[], boolean, text[], text, text, text, text, text, text, regprocedure, boolean, boolean, text, text) FROM PUBLIC;

REVOKE ALL
  ON FUNCTION
    "better_supabase"."audit_event"(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid,
    text, text, jsonb)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION
    "better_supabase"."audit_event"(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid,
    text, text, jsonb)
  TO "service_role";

REVOKE ALL
  ON FUNCTION
    "better_supabase"."audit_event_trusted"(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid,
    uuid, text, text, jsonb)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION
    "better_supabase"."audit_event_trusted"(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid,
    uuid, text, text, jsonb)
  TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."is_service_role"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."is_service_role"() TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."row_visible"(regclass, name, anyelement) FROM PUBLIC;
