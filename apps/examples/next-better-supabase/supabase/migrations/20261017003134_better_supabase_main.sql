SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION better_supabase.audit_entries_correlated (
  correlation text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(l."id"::text order by l."id"), '[]'::jsonb)
  from "better_supabase"."audit_events" l
  where l."correlation_id" = audit_entries_correlated.correlation
    and l."actor_id" is not distinct from auth.uid();
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
  impersonation_reason text  DEFAULT NULL::text
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
  impersonation_reason text  DEFAULT NULL::text
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
      using errcode = '22023', hint = 'Set blocks.audit.options.restricted to true.';
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

CREATE OR REPLACE FUNCTION better_supabase.audit_revert_source (
  entries text[]
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
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
        (select a.key_columns from better_supabase.audited_tables a where a.target = to_regclass(quote_ident(split_part(l."table_name", '.', 1)) || '.' || quote_ident(split_part(l."table_name", '.', 2)))),
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
      or (l."organization_id" is not null and coalesce(better_supabase.member_can(auth.uid(), l."organization_id", 'audit.revert'), false)));
  if jsonb_array_length(found_entries) <> cardinality(array(select distinct e from unnest(audit_revert_source.entries) e)) then
    raise exception 'an entry is missing or not yours to revert' using errcode = 'P0002', hint = 'AUDIT_ENTRY_NOT_FOUND';
  end if;
  return found_entries;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.can (
  scope      text,
  scope_id   uuid,
  permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select case
    when can.scope = 'platform' then coalesce(better_supabase.platform_can(auth.uid(), can.permission), false)
    when can.scope in ('organization', 'tenant') then coalesce(better_supabase.member_can(auth.uid(), can.scope_id, can.permission), false)
    else false
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.can_assign (
  tenant uuid,
  role   text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role' or coalesce((false), false)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.can_user (
  member     uuid,
  scope      text,
  scope_id   uuid,
  permission text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  return case
    when can_user.scope = 'platform' then better_supabase.platform_can(can_user.member, can_user.permission)
    when can_user.scope in ('organization', 'tenant') then better_supabase.member_can(can_user.member, can_user.scope_id, can_user.permission)
    else false
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.cap_allows (
  permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select case
    when jwt is null then true
    when jsonb_typeof(jwt -> 'bs_permission_cap') = 'array'
      and not exists (
        select 1 from jsonb_array_elements_text(jwt -> 'bs_permission_cap') c(key)
        where better_supabase.permission_matches(c.key, cap_allows.permission)
      ) then false
    when coalesce(jwt ->> 'client_id', '') = ''
      and (jwt -> 'act' is null
        or (jsonb_typeof(jwt -> 'act') = 'object'
          and jwt -> 'act' ->> 'kind' in ('support', 'impersonation'))) then true
    else exists (
      select 1
      from unnest(case jsonb_typeof(jwt -> 'scope')
          when 'string' then regexp_split_to_array(btrim(jwt ->> 'scope'), '\s+')
          when 'array' then array(select jsonb_array_elements_text(jwt -> 'scope'))
          else '{}'::text[]
        end) s(scope)
      cross join lateral unnest(better_supabase.scope_permissions(s.scope)) k(key)
      where s.scope <> ''
        and better_supabase.permission_matches(k.key, cap_allows.permission)
    )
  end
  from (select auth.jwt() as jwt) as token
$function$;

CREATE OR REPLACE FUNCTION better_supabase.is_platform (
  permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(better_supabase.platform_can(auth.uid(), is_platform.permission), false)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.member_can (
  member     uuid,
  tenant     uuid,
  permission text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if member is distinct from auth.uid() then
    return not better_supabase.user_disabled(member)
      and not better_supabase.tenant_disabled(tenant)
      and tenant::text in (select t.id::text from permdock.permitted_organization_ids_by_permission_for(member, permission) as t(id));
  end if;
  return not better_supabase.user_disabled(member)
    and not better_supabase.tenant_disabled(tenant)
    and better_supabase.cap_allows(permission)
    and tenant::text in (select t.id::text from permdock.permitted_organization_ids_by_permission(permission) as t(id));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.member_can_while_deleting (
  member     uuid,
  tenant     uuid,
  permission text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if member is distinct from auth.uid() then
    return not better_supabase.user_disabled(member)
      and tenant::text in (select t.id::text from permdock.permitted_organization_ids_by_permission_for(member, permission) as t(id));
  end if;
  return not better_supabase.user_disabled(member)
    and better_supabase.cap_allows(permission)
    and tenant::text in (select t.id::text from permdock.permitted_organization_ids_by_permission(permission) as t(id));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.member_permissions (
  member uuid,
  tenant uuid
)
  RETURNS text[]
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select case
    when member is not null
      and not better_supabase.user_disabled(member)
      and not better_supabase.tenant_disabled(tenant)
    then coalesce((array(select permdock.permitted_organization_permission_keys_for(member, tenant))), '{}'::text[])
    else '{}'::text[]
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.operation_permission (
  op text
)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case op
    when 'audit.revert' then 'audit.revert'
    when 'audit.view' then 'audit.view'
    when 'audit.viewAll' then 'audit.view'
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.permission_claims (
  user_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(better_supabase.member_permissions(permission_claims.user_id, t.id::uuid))), '{}'::jsonb)
  from permdock.member_organization_ids_for(permission_claims.user_id) as t(id)
  where not better_supabase.user_disabled(permission_claims.user_id)
    and not better_supabase.tenant_disabled(t.id::uuid)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.permission_matches (
  granted text,
  wanted  text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select granted = '*' or granted = wanted
    or (right(granted, 2) = '.*' and starts_with(wanted, left(granted, -1)))
$function$;

CREATE OR REPLACE FUNCTION better_supabase.platform_can (
  member     uuid,
  permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select case
    when member = auth.uid() then (platform_can.member is distinct from auth.uid() or auth.jwt() -> 'act' is null) and not better_supabase.user_disabled(member) and better_supabase.cap_allows(permission) and coalesce((permdock.permdock_has_permission(permission)), false)
    when member is not null then (platform_can.member is distinct from auth.uid() or auth.jwt() -> 'act' is null) and not better_supabase.user_disabled(member) and coalesce((permdock.permdock_has_permission_for(member, permission)), false)
    else false
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.purge_audit_log (
  older_than interval DEFAULT '1 year'::interval,
  batch      integer  DEFAULT 10000,
  tenant     uuid     DEFAULT NULL::uuid,
  for_tenant boolean  DEFAULT false
)
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
        (select l."organization_id" from "better_supabase"."audit_events" l where l."organization_id" is not null order by l."organization_id" limit 1)
        union all
        select (select l."organization_id" from "better_supabase"."audit_events" l where l."organization_id" > t.v order by l."organization_id" limit 1)
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
          where l."organization_id" = v_tenant and l."occurred_at" < now() - v_older
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
          where l."organization_id" is null and l."occurred_at" < now() - older_than
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
          and (not for_tenant or l."organization_id" is not distinct from purge_audit_log.tenant)
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

CREATE OR REPLACE FUNCTION better_supabase.revert_audit_entries (
  entries text[]
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scope_permissions (
  scope text
)
  RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case scope
    when 'audit:revert' then array['audit.revert']::text[]
    when 'audit:view' then array['audit.view']::text[]
    when 'quotes:list' then array['quotes.list']::text[]
    when 'quotes:read' then array['quotes.read']::text[]
    when 'quotes:update' then array['quotes.update']::text[]
    when 'staff:list' then array['staff.list']::text[]
    when 'staff:read' then array['staff.read']::text[]
    else array[scope]
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.tenant_disabled (
  tenant uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select false
$function$;

CREATE OR REPLACE FUNCTION better_supabase.tenant_ids_with (
  permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  ROWS 1
  SET search_path TO ''
  AS $function$
  select t.id::uuid from permdock.permitted_organization_ids_by_permission(tenant_ids_with.permission) as t(id)
  where better_supabase.cap_allows(tenant_ids_with.permission)
    and not better_supabase.user_disabled(auth.uid())
    and not better_supabase.tenant_disabled(t.id::uuid)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.user_disabled (
  user_id uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select false
$function$;

CREATE OR REPLACE FUNCTION permdock.grant_keys (
  p_permission text,
  p_scope      text,
  p_effect     text DEFAULT 'allow'::text
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select g.grant_key
  from pg_catalog.jsonb_array_elements_text(coalesce(
    '{"customer":{"quotes.list":{"allow":["quotes.list"],"deny":[]},"quotes.read":{"allow":["quotes.read"],"deny":[]}},"organization":{"audit.revert":{"allow":["audit.revert"],"deny":[]},"audit.view":{"allow":["audit.view"],"deny":[]},"quotes.list":{"allow":["quotes.list"],"deny":[]},"quotes.read":{"allow":["quotes.read"],"deny":[]},"quotes.update":{"allow":["quotes.update"],"deny":[]},"staff.list":{"allow":["staff.list"],"deny":[]},"staff.read":{"allow":["staff.read"],"deny":[]}}}'::jsonb -> p_scope -> p_permission -> p_effect,
    '[]'::jsonb
  )) g(grant_key)
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_permission_keys()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select k.permission from unnest(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'staff.list', 'staff.read']::text[]) k(permission) order by 1
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_permission_keys (
  p_scope text
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select distinct rp.permission
  from "permdock".role_permissions rp
  where rp.scope = p_scope
    and rp.effect = 'allow'
    and rp.permission = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'staff.list', 'staff.read']::text[])
  order by 1
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = (select "permdock".permdock_user_id())
    and rp.scope = 'global'
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = (select "permdock".permdock_user_id())
    and rp.scope = 'global'
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = p_user
    and rp.scope = 'global'
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('audit.revert', 'organization', 'allow', 'audit.revert'),
      ('audit.view', 'organization', 'allow', 'audit.view'),
      ('quotes.list', 'organization', 'allow', 'quotes.list'),
      ('quotes.read', 'organization', 'allow', 'quotes.read'),
      ('quotes.update', 'organization', 'allow', 'quotes.update'),
      ('staff.list', 'organization', 'allow', 'staff.list'),
      ('staff.read', 'organization', 'allow', 'staff.read')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  join "permdock".role_permissions rp on rp.role = ur.role::text
  where ur.user_id = p_user
    and rp.scope = 'global'
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

REVOKE ALL ON FUNCTION "better_supabase"."audit_entries_correlated"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."audit_entries_correlated"(text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."audit_revert_source"(text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."audit_revert_source"(text[]) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."can"(text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."can"(text, uuid, text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."can_assign"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."can_assign"(uuid, text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."can_user"(uuid, text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."can_user"(uuid, text, uuid, text) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."cap_allows"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."cap_allows"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."is_platform"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."is_platform"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."member_can"(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."member_can"(uuid, uuid, text) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."member_can_while_deleting"(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."member_can_while_deleting"(uuid, uuid, text) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."member_permissions"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."member_permissions"(uuid, uuid) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."operation_permission"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."operation_permission"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."permission_claims"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."permission_claims"(uuid) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."permission_matches"(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."permission_matches"(text, text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."platform_can"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."platform_can"(uuid, text) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."revert_audit_entries"(text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."revert_audit_entries"(text[]) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scope_permissions"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scope_permissions"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."tenant_disabled"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."tenant_disabled"(uuid) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."tenant_ids_with"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."tenant_ids_with"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."user_disabled"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."user_disabled"(uuid) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON SCHEMA "better_supabase" FROM "supabase_auth_admin";

GRANT USAGE ON SCHEMA "better_supabase" TO "supabase_auth_admin";
