-- better-supabase module: security-events
-- @bsb-block security-events@1 managed
-- @bsb-hash sha256:ed1993fba361dbb47c5e70879098fc4f93a5a0b5ced17cb8c4e982446d5d68b7
-- OpenID Shared Signals streams: stream configuration and status per receiver, push delivery through a webhooks endpoint with format 'set' (RFC 8935), a poll queue (RFC 8936), SETs held while a stream is paused, and a receiver replay table. Only the service role calls it; createSsfTransmitter() and createSsfReceiver() in better-supabase/blocks/security-events mint and verify the SETs.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

-- Shared Signals streams this app transmits on (OpenID SSF 1.0): one row per
-- receiver stream, pushed through a webhooks endpoint (RFC 8935) or
-- polled (RFC 8936). ssf_events holds SETs to poll or held while paused;
-- ssf_received is the receiver's replay table of (issuer, jti).
create table "better_supabase"."ssf_streams" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant" text constraint bsb_ssf_streams_tenant_check check (length("tenant") >= 1 and length("tenant") <= 200),
  "receiver" text not null constraint bsb_ssf_streams_receiver_check check (length("receiver") >= 1 and length("receiver") <= 200),
  "audience" text[] not null constraint bsb_ssf_streams_audience_check check (cardinality("audience") >= 1 and cardinality("audience") <= 20),
  "description" text constraint bsb_ssf_streams_description_check check (length("description") <= 1000),
  "events_requested" text[] not null default '{}',
  "events_delivered" text[] not null default '{}',
  "delivery_method" text not null constraint bsb_ssf_streams_delivery_method_check check ("delivery_method" in ('urn:ietf:rfc:8935', 'urn:ietf:rfc:8936')),
  "endpoint_id" uuid,
  "status" text not null default 'enabled' constraint bsb_ssf_streams_status_check check ("status" in ('enabled', 'paused', 'disabled')),
  "reason" text constraint bsb_ssf_streams_reason_check check (length("reason") <= 1000),
  "verified_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index ssf_streams_receiver_idx on "better_supabase"."ssf_streams" ("receiver");
create index ssf_streams_events_idx on "better_supabase"."ssf_streams" using gin ("events_delivered");
create index ssf_streams_endpoint_idx on "better_supabase"."ssf_streams" ("endpoint_id") where "endpoint_id" is not null;
create trigger bsb_updated_at before update on "better_supabase"."ssf_streams"
  for each row
  execute function better_supabase.set_updated_at('updated_at');
alter table "better_supabase"."ssf_streams" enable row level security;
revoke all on "better_supabase"."ssf_streams" from public, anon, authenticated;
grant all on "better_supabase"."ssf_streams" to service_role;

create table "better_supabase"."ssf_events" (
  "stream_id" uuid not null references "better_supabase"."ssf_streams" ("id") on delete cascade,
  "jti" text not null constraint bsb_ssf_events_jti_check check (length("jti") >= 1 and length("jti") <= 200),
  "token" text not null,
  "created_at" timestamptz not null default now(),
  primary key ("stream_id", "jti")
);
create index ssf_events_order_idx on "better_supabase"."ssf_events" ("stream_id", "created_at");
create index ssf_events_created_idx on "better_supabase"."ssf_events" ("created_at");
alter table "better_supabase"."ssf_events" enable row level security;
revoke all on "better_supabase"."ssf_events" from public, anon, authenticated;
grant all on "better_supabase"."ssf_events" to service_role;

create table "better_supabase"."ssf_received" (
  "issuer" text not null,
  "jti" text not null constraint bsb_ssf_received_jti_check check (length("jti") >= 1 and length("jti") <= 200),
  "received_at" timestamptz not null default now(),
  primary key ("issuer", "jti")
);
create index ssf_received_at_idx on "better_supabase"."ssf_received" ("received_at");
alter table "better_supabase"."ssf_received" enable row level security;
revoke all on "better_supabase"."ssf_received" from public, anon, authenticated;
grant all on "better_supabase"."ssf_received" to service_role;

-- Creates a stream; a push stream gets a webhooks endpoint with format 'set'.
create or replace function "better_supabase"."create_ssf_stream"(id uuid, receiver text, tenant text, audience text[], delivery_method text, events_requested text[], events_delivered text[], description text default null, endpoint_url text default null, credential_ref jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."ssf_streams";
  v_endpoint uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  insert into "better_supabase"."ssf_streams" ("id", "tenant", "receiver", "audience", "delivery_method", "events_requested", "events_delivered", "description")
  values (create_ssf_stream.id, create_ssf_stream.tenant, create_ssf_stream.receiver, create_ssf_stream.audience,
    create_ssf_stream.delivery_method, coalesce(create_ssf_stream.events_requested, '{}'),
    coalesce(create_ssf_stream.events_delivered, '{}'), create_ssf_stream.description)
  returning * into v_row;
  if v_row."delivery_method" = 'urn:ietf:rfc:8935' then
    raise exception 'push delivery needs the webhooks module' using errcode = '0A000', hint = 'SECURITY_EVENT_PUSH_UNAVAILABLE';
  end if;
  perform better_supabase.audit_event(
    event_type => 'ssf_stream.created',
    category => 'security',
    target_type => 'ssf_stream',
    record_id => v_row."id"::text,
    metadata => jsonb_build_object('streamId', v_row."id", 'receiver', v_row."receiver", 'tenant', v_row."tenant", 'method', v_row."delivery_method")
  );
  return jsonb_build_object(
    'id', v_row."id",
    'tenant', v_row."tenant",
    'receiver', v_row."receiver",
    'audience', to_jsonb(v_row."audience"),
    'description', v_row."description",
    'eventsRequested', to_jsonb(v_row."events_requested"),
    'eventsDelivered', to_jsonb(v_row."events_delivered"),
    'method', v_row."delivery_method",
    'endpointUrl', null::text,
    'status', v_row."status",
    'reason', v_row."reason",
    'createdAt', v_row."created_at",
    'updatedAt', v_row."updated_at"
  );
end;
$$;
revoke execute on function "better_supabase"."create_ssf_stream"(uuid, text, text, text[], text, text[], text[], text, text, jsonb) from public, anon, authenticated;
grant execute on function "better_supabase"."create_ssf_stream"(uuid, text, text, text[], text, text[], text[], text, text, jsonb) to service_role;

-- One stream, or null.
create or replace function "better_supabase"."ssf_stream"(id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  return (select jsonb_build_object(
    'id', s."id",
    'tenant', s."tenant",
    'receiver', s."receiver",
    'audience', to_jsonb(s."audience"),
    'description', s."description",
    'eventsRequested', to_jsonb(s."events_requested"),
    'eventsDelivered', to_jsonb(s."events_delivered"),
    'method', s."delivery_method",
    'endpointUrl', null::text,
    'status', s."status",
    'reason', s."reason",
    'createdAt', s."created_at",
    'updatedAt', s."updated_at"
  ) from "better_supabase"."ssf_streams" s where s."id" = ssf_stream.id);
end;
$$;
revoke execute on function "better_supabase"."ssf_stream"(uuid) from public, anon, authenticated;
grant execute on function "better_supabase"."ssf_stream"(uuid) to service_role;

-- The streams of a receiver, oldest first.
create or replace function "better_supabase"."ssf_streams"(receiver text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
    'id', s."id",
    'tenant', s."tenant",
    'receiver', s."receiver",
    'audience', to_jsonb(s."audience"),
    'description', s."description",
    'eventsRequested', to_jsonb(s."events_requested"),
    'eventsDelivered', to_jsonb(s."events_delivered"),
    'method', s."delivery_method",
    'endpointUrl', null::text,
    'status', s."status",
    'reason', s."reason",
    'createdAt', s."created_at",
    'updatedAt', s."updated_at"
  ) order by s."created_at")
    from "better_supabase"."ssf_streams" s where s."receiver" = ssf_streams.receiver
  ), '[]'::jsonb);
end;
$$;
revoke execute on function "better_supabase"."ssf_streams"(text) from public, anon, authenticated;
grant execute on function "better_supabase"."ssf_streams"(text) to service_role;

-- Updates the receiver-supplied fields present in patch: description,
-- eventsRequested, eventsDelivered and endpointUrl.
create or replace function "better_supabase"."update_ssf_stream"(id uuid, patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."ssf_streams";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  update "better_supabase"."ssf_streams" s set
    "description" = case when update_ssf_stream.patch ? 'description' then update_ssf_stream.patch ->> 'description' else s."description" end,
    "events_requested" = case when update_ssf_stream.patch ? 'eventsRequested'
      then array(select jsonb_array_elements_text(update_ssf_stream.patch -> 'eventsRequested')) else s."events_requested" end,
    "events_delivered" = case when update_ssf_stream.patch ? 'eventsDelivered'
      then array(select jsonb_array_elements_text(update_ssf_stream.patch -> 'eventsDelivered')) else s."events_delivered" end
  where s."id" = update_ssf_stream.id
  returning s.* into v_row;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_row."id",
    'tenant', v_row."tenant",
    'receiver', v_row."receiver",
    'audience', to_jsonb(v_row."audience"),
    'description', v_row."description",
    'eventsRequested', to_jsonb(v_row."events_requested"),
    'eventsDelivered', to_jsonb(v_row."events_delivered"),
    'method', v_row."delivery_method",
    'endpointUrl', null::text,
    'status', v_row."status",
    'reason', v_row."reason",
    'createdAt', v_row."created_at",
    'updatedAt', v_row."updated_at"
  );
end;
$$;
revoke execute on function "better_supabase"."update_ssf_stream"(uuid, jsonb) from public, anon, authenticated;
grant execute on function "better_supabase"."update_ssf_stream"(uuid, jsonb) to service_role;

-- Deletes a stream, its held SETs and its endpoint.
create or replace function "better_supabase"."delete_ssf_stream"(id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."ssf_streams";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  delete from "better_supabase"."ssf_streams" s where s."id" = delete_ssf_stream.id returning s.* into v_row;
  if not found then
    return false;
  end if;
  perform better_supabase.audit_event(
    event_type => 'ssf_stream.deleted',
    category => 'security',
    target_type => 'ssf_stream',
    record_id => v_row."id"::text,
    metadata => jsonb_build_object('streamId', v_row."id", 'receiver', v_row."receiver", 'tenant', v_row."tenant")
  );
  return true;
end;
$$;
revoke execute on function "better_supabase"."delete_ssf_stream"(uuid) from public, anon, authenticated;
grant execute on function "better_supabase"."delete_ssf_stream"(uuid) to service_role;

-- Sends a SET to a stream: dispatched to an enabled push endpoint, queued
-- for polling, held while paused (or while the endpoint is disabled), or
-- dropped on a disabled stream. Returns which.
create or replace function "better_supabase"."queue_ssf_set"(stream_id uuid, jti text, token text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."ssf_streams";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."ssf_streams" s where s."id" = queue_ssf_set.stream_id for update;
  if not found then
    raise exception 'stream not found' using errcode = 'P0002', hint = 'SECURITY_EVENT_STREAM_NOT_FOUND';
  end if;
  if v_row."status" = 'disabled' then
    return 'dropped';
  end if;
  if v_row."delivery_method" = 'urn:ietf:rfc:8935' and v_row."status" = 'enabled' and false then
    null;
    return 'dispatched';
  end if;
  insert into "better_supabase"."ssf_events" ("stream_id", "jti", "token")
  values (v_row."id", queue_ssf_set.jti, queue_ssf_set.token)
  on conflict do nothing;
  return case when v_row."delivery_method" = 'urn:ietf:rfc:8936' and v_row."status" = 'enabled' then 'queued' else 'held' end;
end;
$$;
revoke execute on function "better_supabase"."queue_ssf_set"(uuid, text, text) from public, anon, authenticated;
grant execute on function "better_supabase"."queue_ssf_set"(uuid, text, text) to service_role;

-- Sets a stream's status. Enabling a push stream dispatches the SETs held
-- while it was paused; disabling drops them. Returns the previous status.
create or replace function "better_supabase"."set_ssf_stream_status"(id uuid, status text, reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."ssf_streams";
  v_previous text;
  v_held record;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  if set_ssf_stream_status.status not in ('enabled', 'paused', 'disabled') then
    raise exception 'status is enabled, paused or disabled' using errcode = '22023', hint = 'SECURITY_EVENT_STATUS_INVALID';
  end if;
  select s."status" into v_previous from "better_supabase"."ssf_streams" s where s."id" = set_ssf_stream_status.id for update;
  if not found then
    raise exception 'stream not found' using errcode = 'P0002', hint = 'SECURITY_EVENT_STREAM_NOT_FOUND';
  end if;
  update "better_supabase"."ssf_streams" s set "status" = set_ssf_stream_status.status, "reason" = set_ssf_stream_status.reason
  where s."id" = set_ssf_stream_status.id
  returning s.* into v_row;
  if v_row."status" = 'disabled' then
    delete from "better_supabase"."ssf_events" q where q."stream_id" = v_row."id";
  elsif v_row."status" = 'enabled' and v_row."delivery_method" = 'urn:ietf:rfc:8935' and false then
    for v_held in
      select q."jti" as jti, q."token" as token from "better_supabase"."ssf_events" q
      where q."stream_id" = v_row."id" order by q."created_at"
    loop
      null;
    end loop;
    delete from "better_supabase"."ssf_events" q where q."stream_id" = v_row."id";
  end if;
  if v_previous is distinct from v_row."status" then
    perform better_supabase.audit_event(
    event_type => 'ssf_stream.status_changed',
    category => 'security',
    target_type => 'ssf_stream',
    record_id => v_row."id"::text,
    metadata => jsonb_build_object('streamId', v_row."id", 'receiver', v_row."receiver", 'tenant', v_row."tenant", 'status', v_row."status", 'reason', v_row."reason")
  );
  end if;
  return v_previous;
end;
$$;
revoke execute on function "better_supabase"."set_ssf_stream_status"(uuid, text, text) from public, anon, authenticated;
grant execute on function "better_supabase"."set_ssf_stream_status"(uuid, text, text) to service_role;

-- The streams an event of event_type goes to: streams of the tenant and
-- app-wide streams (no tenant) that deliver it and aren't disabled.
create or replace function "better_supabase"."ssf_streams_for_event"(tenant text, event_type text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s."id", 'audience', to_jsonb(s."audience")) order by s."created_at")
    from "better_supabase"."ssf_streams" s
    where s."status" <> 'disabled'
      and ssf_streams_for_event.event_type = any (s."events_delivered")
      and (s."tenant" is null or s."tenant" = ssf_streams_for_event.tenant)
  ), '[]'::jsonb);
end;
$$;
revoke execute on function "better_supabase"."ssf_streams_for_event"(text, text) from public, anon, authenticated;
grant execute on function "better_supabase"."ssf_streams_for_event"(text, text) to service_role;

-- RFC 8936: acknowledges ack and the jtis in errors, then returns up to
-- max_events SETs of an enabled poll stream. A SET stays until acknowledged.
create or replace function "better_supabase"."poll_ssf_events"(stream_id uuid, max_events integer, ack text[] default '{}', errors jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."ssf_streams";
  v_limit integer := least(greatest(coalesce(poll_ssf_events.max_events, 100), 0), 1000);
  v_sets jsonb;
  v_more boolean;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."ssf_streams" s where s."id" = poll_ssf_events.stream_id;
  if not found then
    raise exception 'stream not found' using errcode = 'P0002', hint = 'SECURITY_EVENT_STREAM_NOT_FOUND';
  end if;
  if v_row."delivery_method" <> 'urn:ietf:rfc:8936' then
    raise exception 'the stream is not delivered by polling' using errcode = '22023', hint = 'SECURITY_EVENT_STREAM_NOT_POLL';
  end if;
  delete from "better_supabase"."ssf_events" q
  where q."stream_id" = v_row."id"
    and (q."jti" = any (coalesce(poll_ssf_events.ack, '{}'))
      or coalesce(poll_ssf_events.errors, '{}'::jsonb) ? q."jti");
  if v_row."status" <> 'enabled' or v_limit = 0 then
    return jsonb_build_object('sets', '{}'::jsonb, 'moreAvailable', false);
  end if;
  select count(*) > v_limit into v_more
  from (select 1 from "better_supabase"."ssf_events" q where q."stream_id" = v_row."id" limit v_limit + 1) x;
  select coalesce(jsonb_object_agg(l.jti, l.token), '{}'::jsonb) into v_sets
  from (
    select q."jti" as jti, q."token" as token from "better_supabase"."ssf_events" q
    where q."stream_id" = v_row."id"
    order by q."created_at", q."jti"
    limit v_limit
  ) l;
  return jsonb_build_object('sets', v_sets, 'moreAvailable', v_more);
end;
$$;
revoke execute on function "better_supabase"."poll_ssf_events"(uuid, integer, text[], jsonb) from public, anon, authenticated;
grant execute on function "better_supabase"."poll_ssf_events"(uuid, integer, text[], jsonb) to service_role;

-- Records a verification request; false when the stream's last one is newer
-- than min_interval, which the endpoint answers with 429.
create or replace function "better_supabase"."note_ssf_verification"(stream_id uuid, min_interval interval)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_noted boolean;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  if not exists (select 1 from "better_supabase"."ssf_streams" s where s."id" = note_ssf_verification.stream_id) then
    raise exception 'stream not found' using errcode = 'P0002', hint = 'SECURITY_EVENT_STREAM_NOT_FOUND';
  end if;
  update "better_supabase"."ssf_streams" s set "verified_at" = now()
  where s."id" = note_ssf_verification.stream_id
    and (s."verified_at" is null or s."verified_at" + coalesce(note_ssf_verification.min_interval, '0 seconds') <= now())
  returning true into v_noted;
  return coalesce(v_noted, false);
end;
$$;
revoke execute on function "better_supabase"."note_ssf_verification"(uuid, interval) from public, anon, authenticated;
grant execute on function "better_supabase"."note_ssf_verification"(uuid, interval) to service_role;

-- The receiver's replay check: true the first time (issuer, jti) is seen.
create or replace function "better_supabase"."record_ssf_received"(issuer text, jti text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new boolean;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  insert into "better_supabase"."ssf_received" ("issuer", "jti")
  values (record_ssf_received.issuer, record_ssf_received.jti)
  on conflict do nothing
  returning true into v_new;
  return coalesce(v_new, false);
end;
$$;
revoke execute on function "better_supabase"."record_ssf_received"(text, text) from public, anon, authenticated;
grant execute on function "better_supabase"."record_ssf_received"(text, text) to service_role;

-- Forgets a received SET whose handler failed, so the transmitter's retry is processed.
create or replace function "better_supabase"."forget_ssf_received"(issuer text, jti text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  delete from "better_supabase"."ssf_received" x where x."issuer" = forget_ssf_received.issuer and x."jti" = forget_ssf_received.jti;
  return found;
end;
$$;
revoke execute on function "better_supabase"."forget_ssf_received"(text, text) from public, anon, authenticated;
grant execute on function "better_supabase"."forget_ssf_received"(text, text) to service_role;

-- Deletes replay entries and held or unpolled SETs older than the retention.
create or replace function "better_supabase"."purge_shared_signals"(older_than interval default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - coalesce(purge_shared_signals.older_than, '7 days'::interval);
  v_received integer;
  v_events integer;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  delete from "better_supabase"."ssf_received" x where x."received_at" < v_cutoff;
  get diagnostics v_received = row_count;
  delete from "better_supabase"."ssf_events" q where q."created_at" < v_cutoff;
  get diagnostics v_events = row_count;
  return v_received + v_events;
end;
$$;
revoke execute on function "better_supabase"."purge_shared_signals"(interval) from public, anon, authenticated;
grant execute on function "better_supabase"."purge_shared_signals"(interval) to service_role;
