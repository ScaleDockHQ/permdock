-- better-supabase 0.8: audit_event and audit_event_trusted take support_session, impersonated_by and impersonation_reason.
SET local check_function_bodies = off;

drop function if exists better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid);
drop function if exists better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text);
drop function if exists better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text);
drop function if exists better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text);
drop function if exists better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text);
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
$$;
revoke execute on function better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.audit_event(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) to "service_role";

-- audit_event for the app's own security definer functions: it honours
-- actor_id, actor_kind, actor_label, scope and the request details from any
-- caller, so only the owner, the service role and
-- sql.modules.audit.options.trustedRoles may execute it. A function owned by
-- postgres calls it on behalf of a client with the real actor context.
drop function if exists better_supabase.audit_event_trusted(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text);
drop function if exists better_supabase.audit_event_trusted(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text);
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
$$;
revoke execute on function better_supabase.audit_event_trusted(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.audit_event_trusted(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid, text, text, text, text, text, inet, text, text, text, text, uuid, uuid, text) to "service_role";
