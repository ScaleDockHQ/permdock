SET local check_function_bodies = off;

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
$function$;

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
  skip                integer                  DEFAULT 0
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
  result jsonb;
begin
  if cardinality(for_tenants) > 0 then
    v_where := v_where || $q$ and l."organization_id" = any ($1)$q$;
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
    select jsonb_build_object('id', l."id", 'table', l."table_name", 'record', l."record_id", 'op', l."op", 'old', l."old_record", 'new', l."new_record", 'changed', l."changed", 'actorId', l."actor_id", 'actorRole', l."actor_role", 'actorKind', l."actor_kind", 'actorLabel', l."actor_label", 'tenant', l."organization_id", 'tenantLabel', l."tenant_label", 'occurredAt', l."occurred_at", 'impersonatedBy', l."impersonated_by", 'impersonationReason', l."impersonation_reason", 'supportSession', l."support_session_id", 'eventType', l."event_type", 'category', l."category", 'outcome', l."outcome") || jsonb_build_object('source', l."source", 'targetType', l."target_type", 'targetLabel', l."target_label", 'summary', l."summary", 'requestId', l."request_id", 'correlationId', l."correlation_id", 'scope', l."scope", 'metadata', l."metadata") as entry, l."occurred_at" as occurred_at, l."id" as id
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

REVOKE ALL ON FUNCTION "better_supabase"."audit_event_many"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."audit_event_many"(jsonb) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."audit_row_change"() FROM PUBLIC;
