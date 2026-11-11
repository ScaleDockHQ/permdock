set local check_function_bodies = off;

COMMENT ON CONSTRAINT "bsb_audit_op_check" ON "better_supabase"."audit_events" IS NULL;

DROP TRIGGER "bsb_audit" ON "better_supabase"."share_links";

DROP INDEX "better_supabase"."audit_events_organization_idx";

DROP FUNCTION "better_supabase"."count_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamp with time zone, timestamp with time zone);

DROP FUNCTION "better_supabase"."list_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamp with time zone, timestamp with time zone, timestamp with time zone, text, integer, boolean, integer);

CREATE TABLE "better_supabase"."chain_checkpoints" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "table_name" text NOT NULL, "tenant" text, "chain_seq" bigint NOT NULL, "row_hash" bytea NOT NULL, "key_id" text NOT NULL, "signature" text NOT NULL, "created_at" timestamp with time zone NOT NULL DEFAULT now(), CONSTRAINT "chain_checkpoints_pkey" PRIMARY KEY (id));

ALTER TABLE "better_supabase"."chain_checkpoints" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION better_supabase.append_only(target regclass)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  execute format('drop trigger if exists bsb_append_only on %s', target);
  execute format('create trigger bsb_append_only before update or delete on %s for each row execute function better_supabase.append_only_guard()', target);
  execute format('drop trigger if exists bsb_append_only_truncate on %s', target);
  execute format('create trigger bsb_append_only_truncate before truncate on %s for each statement execute function better_supabase.append_only_guard()', target);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception '% is append-only', tg_table_name
    using errcode = '42501', hint = 'TABLE_APPEND_ONLY';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.as_column_type(value text, target anyelement)
 RETURNS anyelement
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
  return value;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit(target regclass, ignore text[] DEFAULT '{}'::text[], replace_trigger boolean DEFAULT false, redact text[] DEFAULT '{}'::text[], category text DEFAULT NULL::text, event_prefix text DEFAULT NULL::text, target_type text DEFAULT NULL::text, tenant_column text DEFAULT NULL::text, label_column text DEFAULT NULL::text, tenant_path text DEFAULT NULL::text, tenant_function regprocedure DEFAULT NULL::regprocedure, deferred boolean DEFAULT false, statement boolean DEFAULT false)
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event(event_type text, category text DEFAULT NULL::text, outcome text DEFAULT 'success'::text, source text DEFAULT NULL::text, target_type text DEFAULT NULL::text, record_id text DEFAULT NULL::text, tenant uuid DEFAULT NULL::uuid, metadata jsonb DEFAULT '{}'::jsonb, idempotency_key text DEFAULT NULL::text, restricted jsonb DEFAULT NULL::jsonb, actor_id uuid DEFAULT NULL::uuid, summary text DEFAULT NULL::text, target_label text DEFAULT NULL::text, correlation_id text DEFAULT NULL::text, actor_kind text DEFAULT NULL::text, actor_label text DEFAULT NULL::text, ip inet DEFAULT NULL::inet, user_agent text DEFAULT NULL::text, session_id text DEFAULT NULL::text, request_id text DEFAULT NULL::text, scope text DEFAULT NULL::text, support_session uuid DEFAULT NULL::uuid, impersonated_by uuid DEFAULT NULL::uuid, impersonation_reason text DEFAULT NULL::text)
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event_trusted(event_type text, category text DEFAULT NULL::text, outcome text DEFAULT 'success'::text, source text DEFAULT NULL::text, target_type text DEFAULT NULL::text, record_id text DEFAULT NULL::text, tenant uuid DEFAULT NULL::uuid, metadata jsonb DEFAULT '{}'::jsonb, idempotency_key text DEFAULT NULL::text, restricted jsonb DEFAULT NULL::jsonb, actor_id uuid DEFAULT NULL::uuid, summary text DEFAULT NULL::text, target_label text DEFAULT NULL::text, correlation_id text DEFAULT NULL::text, actor_kind text DEFAULT NULL::text, actor_label text DEFAULT NULL::text, ip inet DEFAULT NULL::inet, user_agent text DEFAULT NULL::text, session_id text DEFAULT NULL::text, request_id text DEFAULT NULL::text, scope text DEFAULT NULL::text, support_session uuid DEFAULT NULL::uuid, impersonated_by uuid DEFAULT NULL::uuid, impersonation_reason text DEFAULT NULL::text)
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event_types(for_tenants uuid[] DEFAULT NULL::uuid[])
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_events_tenants(older_than interval DEFAULT '1 day'::interval)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select distinct l."tenant_id" from "better_supabase"."audit_events" l
  where l."occurred_at" < now() - older_than
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_revert_source(entries text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_row_change()
 RETURNS trigger
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_statement_change()
 RETURNS trigger
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.chain(target regclass, tenant_column text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.chain_heads(target regclass, tenant_column text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.chain_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.chain_proof(target regclass, tenant_column text, tenant text, seq bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.chain_row_hash(entry jsonb, prev bytea)
 RETURNS bytea
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select pg_catalog.sha256(
    coalesce(prev, ''::bytea)
    || pg_catalog.convert_to(pg_catalog.jsonb_strip_nulls(entry - 'prev_hash' - 'row_hash')::text, 'UTF8')
  )
$function$;

CREATE OR REPLACE FUNCTION better_supabase.column_default(relation text, name text, target anyelement)
 RETURNS anyelement
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  result alias for $0;
  v_default text;
begin
  select pg_catalog.pg_get_expr(d.adbin, d.adrelid) into v_default
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = pg_catalog.to_regclass(column_default.relation) and a.attname = column_default.name and not a.attisdropped;
  if v_default is not null then
    execute 'select ' || v_default into result;
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.count_audit_events(for_tenants uuid[] DEFAULT NULL::uuid[], for_event_types text[] DEFAULT NULL::text[], for_actors uuid[] DEFAULT NULL::uuid[], for_target_types text[] DEFAULT NULL::text[], for_records text[] DEFAULT NULL::text[], for_categories text[] DEFAULT NULL::text[], for_outcomes text[] DEFAULT NULL::text[], search text DEFAULT NULL::text, for_sources text[] DEFAULT NULL::text[], for_actor_kinds text[] DEFAULT NULL::text[], for_correlation_ids text[] DEFAULT NULL::text[], since timestamp with time zone DEFAULT NULL::timestamp with time zone, until timestamp with time zone DEFAULT NULL::timestamp with time zone, cap integer DEFAULT NULL::integer)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.function_writes(target regclass)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  execute format('revoke insert, update, delete, truncate on %s from public, anon, authenticated', target);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_audit_event(entry_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  result jsonb;
begin
  execute $q$select $q$ || $e$jsonb_build_object('id', l."id", 'table', l."table_name", 'record', l."record_id", 'op', l."op", 'old', l."old_record", 'new', l."new_record", 'changed', l."changed", 'actorId', l."actor_id", 'actorRole', l."actor_role", 'actorKind', l."actor_kind", 'actorLabel', l."actor_label", 'tenant', l."tenant_id", 'tenantLabel', l."tenant_label", 'occurredAt', l."occurred_at", 'impersonatedBy', l."impersonated_by", 'impersonationReason', l."impersonation_reason", 'supportSession', l."support_session_id", 'eventType', l."event_type", 'category', l."category", 'outcome', l."outcome") || jsonb_build_object('source', l."source", 'targetType', l."target_type", 'targetLabel', l."target_label", 'summary', l."summary", 'requestId', l."request_id", 'correlationId', l."correlation_id", 'scope', l."scope", 'metadata', l."metadata")$e$ || $q$ from "better_supabase"."audit_events" l where l."id" = $1$q$
  into result
  using entry_id::bigint;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.importing()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select better_supabase.import_run() is not null;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_audit_events(for_tenants uuid[] DEFAULT NULL::uuid[], for_event_types text[] DEFAULT NULL::text[], for_actors uuid[] DEFAULT NULL::uuid[], for_target_types text[] DEFAULT NULL::text[], for_records text[] DEFAULT NULL::text[], for_categories text[] DEFAULT NULL::text[], for_outcomes text[] DEFAULT NULL::text[], search text DEFAULT NULL::text, for_sources text[] DEFAULT NULL::text[], for_actor_kinds text[] DEFAULT NULL::text[], for_correlation_ids text[] DEFAULT NULL::text[], since timestamp with time zone DEFAULT NULL::timestamp with time zone, until timestamp with time zone DEFAULT NULL::timestamp with time zone, cursor_at timestamp with time zone DEFAULT NULL::timestamp with time zone, cursor_id text DEFAULT NULL::text, max_items integer DEFAULT 50, ascending boolean DEFAULT false, skip integer DEFAULT 0, entry_fields text DEFAULT 'full'::text)
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_chain_checkpoints(target regclass, tenant text DEFAULT NULL::text, max_rows integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.memo_slot_get(key text)
 RETURNS text
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select case when pg_catalog.split_part(v.slot, pg_catalog.chr(31), 1) = key
    then nullif(pg_catalog.substr(v.slot, pg_catalog.length(key) + 2), '') end
  from (select pg_catalog.current_setting('better_supabase.memo.s' || (pg_catalog.hashtext(key) & 255)::text, true) as slot) v
$function$;

CREATE OR REPLACE FUNCTION better_supabase.memo_slot_set(key text, value text)
 RETURNS text
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select pg_catalog.set_config('better_supabase.memo.s' || (pg_catalog.hashtext(key) & 255)::text, key || pg_catalog.chr(31) || coalesce(value, ''), true)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.merge_subject_refs(subject_table text, keep text, drop text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_fn regproc;
begin
  for v_fn in
    select p.oid::regproc
    from pg_catalog.pg_proc p
    join pg_catalog.pg_description d on d.objoid = p.oid and d.classoid = 'pg_catalog.pg_proc'::regclass and d.objsubid = 0
    where d.description = 'better-supabase:subject-merge'
      -- Only the owner's functions, so a marked function in a schema another
      -- role can write to never runs with this function's rights.
      and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
    order by p.oid::regproc::text
  loop
    execute format('select %s($1, $2, $3)', v_fn) using subject_table, keep, drop;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.normalize_phone(value text, region text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when compact like '00%' then '+' || regexp_replace(substring(compact from 3), '\D', '', 'g')
    when compact like '+%' then '+' || regexp_replace(substring(compact from 2), '\D', '', 'g')
    when upper(region) = 'NL' and digits like '0%' then '+31' || substring(digits from 2)
    when upper(region) = 'DE' and digits like '0%' then '+49' || substring(digits from 2)
    when upper(region) = 'FR' and digits like '0%' then '+33' || substring(digits from 2)
    when upper(region) = 'GB' and digits like '0%' then '+44' || substring(digits from 2)
    when upper(region) = 'US' then '+1' || digits
    else digits
  end
  from (
    select regexp_replace(coalesce(value, ''), '[\s().-]', '', 'g') as compact
  ) raw,
  lateral (
    select case when compact like '00%' then substring(compact from 3) else compact end as body
  ) body,
  lateral (
    select regexp_replace(body, '\D', '', 'g') as digits
  ) digits
$function$;

CREATE OR REPLACE FUNCTION better_supabase.operation_permission(op text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case op
    when 'audit.read' then 'audit.read'
    when 'audit.readAll' then 'audit.read'
    when 'audit.revert' then 'audit.revert'
    when 'permissions.listRoles' then 'members.read'
    when 'permissions.setOverride' then 'roles.manage'
    when 'share-links.create' then 'quotes.update'
    when 'share-links.read' then 'quotes.read'
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.purge_audit_log(older_than interval DEFAULT '1 year'::interval, batch integer DEFAULT 10000, tenant uuid DEFAULT NULL::uuid, for_tenant boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.record_chain_checkpoint(target regclass, tenant_column text, tenant text, seq bigint, hash text, key_id text, signature text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.try_column_type(value text, target anyelement)
 RETURNS anyelement
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  result alias for $0;
begin
  result := value;
  return result;
exception when data_exception or check_violation then
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.validate_iban(value text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  compact text;
  moved text;
  rest integer := 0;
  i integer;
  piece text;
  j integer;
begin
  compact := upper(regexp_replace(coalesce(value, ''), '\s', '', 'g'));
  if compact !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then
    return false;
  end if;
  moved := substring(compact from 5) || substring(compact from 1 for 4);
  for i in 1 .. char_length(moved) loop
    piece := case
      when substring(moved from i for 1) between 'A' and 'Z'
        then (ascii(substring(moved from i for 1)) - 55)::text
      else substring(moved from i for 1)
    end;
    for j in 1 .. char_length(piece) loop
      rest := (rest * 10 + ascii(substring(piece from j for 1)) - 48) % 97;
    end loop;
  end loop;
  return rest = 1;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.value_unsupported(label text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception 'the app does not support the value %', label
    using errcode = '22023', hint = 'VALUE_UNSUPPORTED';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.verify_chain(target regclass, tenant_column text DEFAULT NULL::text, tenant text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
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
$function$;

CREATE INDEX audit_events_actor_idx ON better_supabase.audit_events USING btree (tenant_id, actor_id, occurred_at DESC, id DESC);

CREATE INDEX audit_events_event_type_idx ON better_supabase.audit_events USING btree (tenant_id, event_type, occurred_at DESC, id DESC);

CREATE INDEX audit_events_organization_idx ON better_supabase.audit_events USING btree (tenant_id, occurred_at DESC, id DESC);

CREATE INDEX chain_checkpoints_idx ON better_supabase.chain_checkpoints USING btree (table_name, tenant, chain_seq DESC);

CREATE CONSTRAINT TRIGGER bsb_audit AFTER INSERT OR DELETE OR UPDATE ON better_supabase.share_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((better_supabase.import_run() IS NULL) OR (current_setting('better_supabase.import_audit'::text, true) IS DISTINCT FROM 'summary'::text))) EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"share_link","event_prefix":"share_link"}');

REVOKE ALL ON FUNCTION "better_supabase"."append_only"(regclass) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."append_only_guard"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."as_column_type"(text, anyelement) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."as_column_type"(text, anyelement) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."audit_event_types"(uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."audit_event_types"(uuid[]) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."chain"(regclass, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."chain_heads"(regclass, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."chain_heads"(regclass, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."chain_link"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."chain_proof"(regclass, text, text, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."chain_proof"(regclass, text, text, bigint) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."chain_row_hash"(jsonb, bytea) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."column_default"(text, text, anyelement) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."count_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamp with time zone, timestamp with time zone, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."count_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamp with time zone, timestamp with time zone, integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."function_writes"(regclass) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."get_audit_event"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."get_audit_event"(text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."importing"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."importing"() TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamp with time zone, timestamp with time zone, timestamp with time zone, text, integer, boolean, integer, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_audit_events"(uuid[], text[], uuid[], text[], text[], text[], text[], text, text[], text[], text[], timestamp with time zone, timestamp with time zone, timestamp with time zone, text, integer, boolean, integer, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_chain_checkpoints"(regclass, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_chain_checkpoints"(regclass, text, integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."merge_subject_refs"(text, text, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."normalize_phone"(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."normalize_phone"(text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."record_chain_checkpoint"(regclass, text, text, bigint, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."record_chain_checkpoint"(regclass, text, text, bigint, text, text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."try_column_type"(text, anyelement) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."try_column_type"(text, anyelement) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."validate_iban"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."validate_iban"(text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."value_unsupported"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."value_unsupported"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."verify_chain"(regclass, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."verify_chain"(regclass, text, text) TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."chain_checkpoints" TO "service_role";
