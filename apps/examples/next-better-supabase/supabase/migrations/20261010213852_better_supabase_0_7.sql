SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION better_supabase.audit_event (
  event_type      text,
  category        text  DEFAULT NULL::text,
  outcome         text  DEFAULT 'success'::text,
  source          text  DEFAULT NULL::text,
  target_type     text  DEFAULT NULL::text,
  record_id       text  DEFAULT NULL::text,
  tenant          uuid  DEFAULT NULL::uuid,
  metadata        jsonb DEFAULT '{}'::jsonb,
  idempotency_key text  DEFAULT NULL::text,
  restricted      jsonb DEFAULT NULL::jsonb,
  actor_id        uuid  DEFAULT NULL::uuid,
  summary         text  DEFAULT NULL::text,
  target_label    text  DEFAULT NULL::text,
  correlation_id  text  DEFAULT NULL::text,
  actor_kind      text  DEFAULT NULL::text,
  actor_label     text  DEFAULT NULL::text,
  ip              inet  DEFAULT NULL::inet,
  user_agent      text  DEFAULT NULL::text,
  session_id      text  DEFAULT NULL::text,
  request_id      text  DEFAULT NULL::text,
  scope           text  DEFAULT NULL::text
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  existing text;
  entry_id "better_supabase"."audit_events"."id"%type;
begin
  if restricted is not null or ip is not null or user_agent is not null or session_id is not null then
    raise exception 'audit_event got restricted details, and the audit module has no restricted table'
      using errcode = '22023', hint = 'Set sql.modules.audit.options.restricted to true.';
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
  elsif actor_id is null then
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
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "organization_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event_trusted (
  event_type      text,
  category        text  DEFAULT NULL::text,
  outcome         text  DEFAULT 'success'::text,
  source          text  DEFAULT NULL::text,
  target_type     text  DEFAULT NULL::text,
  record_id       text  DEFAULT NULL::text,
  tenant          uuid  DEFAULT NULL::uuid,
  metadata        jsonb DEFAULT '{}'::jsonb,
  idempotency_key text  DEFAULT NULL::text,
  restricted      jsonb DEFAULT NULL::jsonb,
  actor_id        uuid  DEFAULT NULL::uuid,
  summary         text  DEFAULT NULL::text,
  target_label    text  DEFAULT NULL::text,
  correlation_id  text  DEFAULT NULL::text,
  actor_kind      text  DEFAULT NULL::text,
  actor_label     text  DEFAULT NULL::text,
  ip              inet  DEFAULT NULL::inet,
  user_agent      text  DEFAULT NULL::text,
  session_id      text  DEFAULT NULL::text,
  request_id      text  DEFAULT NULL::text,
  scope           text  DEFAULT NULL::text
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  existing text;
  entry_id "better_supabase"."audit_events"."id"%type;
begin
  if restricted is not null or ip is not null or user_agent is not null or session_id is not null then
    raise exception 'audit_event got restricted details, and the audit module has no restricted table'
      using errcode = '22023', hint = 'Set sql.modules.audit.options.restricted to true.';
  end if;
  actor_id := coalesce(actor_id, auth.uid());
  if idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('better_supabase.audit_event'), pg_catalog.hashtext(coalesce(tenant::text, '') || ':' || idempotency_key));
    select l."id"::text into existing
    from "better_supabase"."audit_events" l
    where l."idempotency_key" = audit_event_trusted.idempotency_key
      and l."organization_id" is not distinct from audit_event_trusted.tenant
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
    case when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'sub')::uuid end,
    auth.jwt() -> 'act' ->> 'reason',
    case when auth.jwt() -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'session_id')::uuid end,
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
    coalesce(audit_event_trusted.scope, case when tenant is null then 'platform' else 'tenant' end)
  )
  returning "id" into entry_id;
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
      settings ->> 'label_column' as label_column
    into entry;
  else
    select coalesce(a.ignore, '{}') as ignore, coalesce(a.key_columns, '{id}') as key_columns,
      coalesce(a.redact, '{}') as redact, a.category, a.event_prefix, a.target_type, a.tenant_column,
      a.label_column
    into entry
    from (select 1) one
    left join better_supabase.audited_tables a on a.target = tg_relid::regclass;
  end if;
  row_tenant := case when row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end;
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
    auth.uid(),
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.request_id_or_null (
  value text
)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case when value ~ '^[A-Za-z0-9._:;,@/+=-]{1,128}$' then value end;
$function$;

CREATE INDEX audit_events_correlation_idx ON better_supabase.audit_events USING btree (correlation_id)
  WHERE (correlation_id IS NOT NULL);
