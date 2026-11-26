-- better-supabase module: access-requests
-- @bsb-block access-requests@1 managed
-- @bsb-hash sha256:eef14bc9ba576c5e64ee93074d1ed7082ee2308cdb0f5edc422559e430e468ee
-- Members ask for a role or for access to one record, for a set time if they like. The request goes through approvals; the final approval grants it, and the grant ends early on request or when it expires. Emergency access opens a record at once and waits for a review.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create table "better_supabase"."access_requests" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "user_id" uuid not null,
  "role" text not null constraint bsb_access_requests_role_check check (length("role") >= 1 and length("role") <= 200),
  "previous_role" text,
  "reason" text constraint bsb_access_requests_reason_check check ("reason" is null or length("reason") <= 2000),
  "duration" interval constraint bsb_access_requests_duration_check check ("duration" is null or "duration" > interval '0'),
  "approval_id" uuid references "better_supabase"."approval_requests" ("id") on delete cascade,
  "granted_at" timestamptz,
  "expires_at" timestamptz,
  "ended_at" timestamptz,
  "created_at" timestamptz not null default now()
);
create index "access_requests_tenant_idx" on "better_supabase"."access_requests" ("tenant_id", "created_at" desc, "id" desc);
create index "access_requests_approval_idx" on "better_supabase"."access_requests" ("approval_id") where "approval_id" is not null;
create index "access_requests_expiry_idx" on "better_supabase"."access_requests" ("expires_at") where "granted_at" is not null and "ended_at" is null;
alter table "better_supabase"."access_requests" enable row level security;
revoke all on "better_supabase"."access_requests" from public, anon, authenticated;
grant select on "better_supabase"."access_requests" to authenticated;
grant all on "better_supabase"."access_requests" to service_role;
create policy bsb_access_requests_read on "better_supabase"."access_requests"
  for select to authenticated
  using ("tenant_id" in (select better_supabase.tenant_ids_with('access_requests.read')) or "user_id" = (select auth.uid()));

-- Asks for a role in an organization. Approvers come from options.policy;
-- the final approval calls grant_access_request.

create or replace function "better_supabase"."request_access"(tenant uuid, role text, reason text default null, duration interval default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
set intervalstyle = 'iso_8601'
as $$
#variable_conflict use_column
declare
  v_me uuid := auth.uid();
  v_current text;
  v_duration interval;
  v_row "better_supabase"."access_requests"%rowtype;
  v_approval jsonb;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if v_me is null then
    raise exception 'sign in to request access' using errcode = '42501', hint = 'ACCESS_SIGN_IN';
  end if;
  select m."role" into v_current from "public"."organization_memberships" m
  where m."organization_id" = request_access.tenant and m."user_id" = v_me;
  if not found then
    raise exception 'only members can request a role' using errcode = '42501', hint = 'ACCESS_REQUEST_FORBIDDEN';
  elsif not coalesce(better_supabase.can('tenant', request_access.tenant, 'access_requests.create'), false) then
    raise exception 'not allowed to request a role here' using errcode = '42501', hint = 'ACCESS_REQUEST_FORBIDDEN';
  end if;
  if not (request_access.role = any (array['admin', 'member', 'viewer']::text[])) then
    raise exception 'this role can''t be requested' using errcode = '22023', hint = 'ACCESS_ROLE_INVALID';
  end if;
  if v_current = request_access.role then
    raise exception 'you already hold this role' using errcode = '22023', hint = 'ACCESS_ROLE_HELD';
  end if;
  if v_current = 'owner' then
    raise exception 'an owner can''t request another role' using errcode = '22023', hint = 'ACCESS_ROLE_INVALID';
  end if;
  v_duration := request_access.duration;
  if v_duration is not null and v_duration <= interval '0' then
    raise exception 'duration must be positive' using errcode = '22023', hint = 'ACCESS_DURATION_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('access_request:' || request_access.tenant::text || ':' || v_me::text, 0));
  if exists (
    select 1 from "better_supabase"."access_requests" r join "better_supabase"."approval_requests" x on x."id" = r."approval_id"
    where r."tenant_id" = request_access.tenant and r."user_id" = v_me and x."status" = 'pending'
  ) then
    raise exception 'you already have a pending access request here' using errcode = '23505', hint = 'ACCESS_REQUEST_PENDING';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_access_request"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using request_access.tenant, request_access.role;
    end if;
  end;
  insert into "better_supabase"."access_requests" ("tenant_id", "user_id", "role", "reason", "duration")
  values (request_access.tenant, v_me, request_access.role, request_access.reason, v_duration)
  returning * into v_row;
  v_approval := "better_supabase"."open_approval"(
    request_access.tenant, 'access_request', v_row."id"::text, 'grant',
    '{"steps":[{"approvers":{"permission":"members.update_role"},"required":1}],"selfApproval":false,"expiresIn":null,"run":null}'::jsonb, request_access.reason,
    jsonb_build_object('role', request_access.role, 'userId', v_me, 'duration', v_duration::text)
  );
  update "better_supabase"."access_requests" r set "approval_id" = (v_approval ->> 'id')::uuid
  where r."id" = v_row."id"
  returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'access_request.requested',
    category => 'membership',
    target_type => 'user',
    record_id => v_row."user_id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'userId', v_row."user_id", 'role', v_row."role", 'id', v_row."id", 'approvalId', v_row."approval_id", 'expiresAt', v_row."expires_at", 'target', 'role', 'subjectType', null::text, 'subjectId', null::text, 'action', null::text)
  );
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_access_request"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'userId', v_row."user_id", 'role', v_row."role", 'previousRole', v_row."previous_role", 'reason', v_row."reason", 'duration', v_row."duration"::text, 'status', 'pending', 'approvalId', v_row."approval_id", 'grantedAt', v_row."granted_at", 'expiresAt', v_row."expires_at", 'endedAt', v_row."ended_at", 'createdAt', v_row."created_at");
end;
$$;
revoke execute on function "better_supabase"."request_access"(uuid, text, text, interval) from public, anon;
grant execute on function "better_supabase"."request_access"(uuid, text, text, interval) to authenticated, service_role;

-- Grants the role once the approval is final. Approvals calls it; it
-- isn't granted to anyone.
create or replace function "better_supabase"."grant_access_request"(request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."access_requests"%rowtype;
  v_previous text;
begin
  select * into v_row from "better_supabase"."access_requests" r where r."id" = grant_access_request.request_id for update;
  if not found or v_row."granted_at" is not null then
    return;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_access_grant"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
  -- The authorization provider's adapter grants the role from the event.
  null;
  update "better_supabase"."access_requests" r
  set "previous_role" = v_previous,
      "granted_at" = now(),
      "expires_at" = case when v_row."duration" is null then null else now() + v_row."duration" end
  where r."id" = v_row."id"
  returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'access_request.approved',
    category => 'membership',
    target_type => 'user',
    record_id => v_row."user_id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'userId', v_row."user_id", 'role', v_row."role", 'id', v_row."id", 'approvalId', v_row."approval_id", 'expiresAt', v_row."expires_at", 'target', 'role', 'subjectType', null::text, 'subjectId', null::text, 'action', null::text)
  );
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_access_grant"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
end;
$$;
revoke execute on function "better_supabase"."grant_access_request"(uuid) from public, anon, authenticated;

-- Ends a granted role early: a manager, or the holder giving it up.
create or replace function "better_supabase"."end_access"(request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set intervalstyle = 'iso_8601'
as $$
declare
  v_row "better_supabase"."access_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."access_requests" r where r."id" = end_access.request_id for update;
  if not found then
    raise exception 'access request not found' using errcode = 'P0002', hint = 'ACCESS_REQUEST_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_row."user_id" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'access_requests.manage'), false)) then
    raise exception 'not allowed to end this access' using errcode = '42501', hint = 'ACCESS_REQUEST_FORBIDDEN';
  end if;
  if v_row."granted_at" is null or v_row."ended_at" is not null then
    raise exception 'this access isn''t active' using errcode = '22023', hint = 'ACCESS_NOT_GRANTED';
  end if;
  update "better_supabase"."access_requests" r set "ended_at" = now() where r."id" = v_row."id" returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'access_request.ended',
    category => 'membership',
    target_type => 'user',
    record_id => v_row."user_id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'userId', v_row."user_id", 'role', v_row."role", 'id', v_row."id", 'approvalId', v_row."approval_id", 'expiresAt', v_row."expires_at", 'target', 'role', 'subjectType', null::text, 'subjectId', null::text, 'action', null::text, 'reason', 'revoked')
  );
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'userId', v_row."user_id", 'role', v_row."role", 'previousRole', v_row."previous_role", 'reason', v_row."reason", 'duration', v_row."duration"::text, 'status', 'ended', 'approvalId', v_row."approval_id", 'grantedAt', v_row."granted_at", 'expiresAt', v_row."expires_at", 'endedAt', v_row."ended_at", 'createdAt', v_row."created_at");
end;
$$;
revoke execute on function "better_supabase"."end_access"(uuid) from public, anon;
grant execute on function "better_supabase"."end_access"(uuid) to authenticated, service_role;

-- Ends grants past their expiry. Schedule it with pg_cron or the jobs drain.
create or replace function "better_supabase"."expire_access_grants"(max_grants integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."access_requests"%rowtype;
  v_count integer := 0;
begin
  for v_row in
    select * from "better_supabase"."access_requests" r
    where r."granted_at" is not null and r."ended_at" is null and r."expires_at" <= now()
    order by r."expires_at"
    limit greatest(coalesce(expire_access_grants.max_grants, 200), 1)
    for update skip locked
  loop
    update "better_supabase"."access_requests" r set "ended_at" = now() where r."id" = v_row."id" returning * into v_row;
    perform better_supabase.audit_event(
    event_type => 'access_request.ended',
    category => 'membership',
    target_type => 'user',
    record_id => v_row."user_id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'userId', v_row."user_id", 'role', v_row."role", 'id', v_row."id", 'approvalId', v_row."approval_id", 'expiresAt', v_row."expires_at", 'target', 'role', 'subjectType', null::text, 'subjectId', null::text, 'action', null::text, 'reason', 'expired')
  );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke execute on function "better_supabase"."expire_access_grants"(integer) from public, anon, authenticated;
grant execute on function "better_supabase"."expire_access_grants"(integer) to service_role;

create or replace function "better_supabase"."get_access_request"(request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set intervalstyle = 'iso_8601'
as $$
declare
  v_row "better_supabase"."access_requests"%rowtype;
  v_approval "better_supabase"."approval_requests"%rowtype;
begin
  select * into v_row from "better_supabase"."access_requests" r where r."id" = get_access_request.request_id;
  if not found or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_row."user_id" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'access_requests.read'), false)) then
    raise exception 'access request not found' using errcode = 'P0002', hint = 'ACCESS_REQUEST_NOT_FOUND';
  end if;
  select * into v_approval from "better_supabase"."approval_requests" x where x."id" = v_row."approval_id";
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'userId', v_row."user_id", 'role', v_row."role", 'previousRole', v_row."previous_role", 'reason', v_row."reason", 'duration', v_row."duration"::text, 'status', case when v_row."ended_at" is not null then 'ended' when v_row."granted_at" is not null then 'granted' else coalesce(v_approval."status", 'pending') end, 'approvalId', v_row."approval_id", 'grantedAt', v_row."granted_at", 'expiresAt', v_row."expires_at", 'endedAt', v_row."ended_at", 'createdAt', v_row."created_at");
end;
$$;
revoke execute on function "better_supabase"."get_access_request"(uuid) from public, anon;
grant execute on function "better_supabase"."get_access_request"(uuid) to authenticated, service_role;

-- Newest first. Readers of the organization see every request; others see
-- their own. filters is { status, mine, role, before, sort, direction, facet,
-- count, limit, after, offset, paged, total, totalCap } (ADR 0749); status and
-- role take a value or a list, mine takes true, and before is a timestamp that
-- keeps older requests.
create or replace function "better_supabase"."list_access_requests"(tenant uuid, filters jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set intervalstyle = 'iso_8601'
as $$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(list_access_requests.filters, '{}'::jsonb);
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('status', 'role') then
      raise exception 'facet is one of status, role' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
    end if;
    with s as (
      select (case v_facet when 'status' then (r.bs_status)::text when 'role' then (r."role")::text end) as v
      from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('createdAt') then
    raise exception 'sort is one of createdAt' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'userId', r."user_id", 'role', r."role", 'previousRole', r."previous_role", 'reason', r."reason", 'duration', r."duration"::text, 'status', r.bs_status, 'approvalId', r."approval_id", 'grantedAt', r."granted_at", 'expiresAt', r."expires_at", 'endedAt', r."ended_at", 'createdAt', r."created_at") as j, jsonb_build_array((r."created_at")::text, (r."id")::text) as k
    from (
      select * from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
        and (v_after is null or (r."created_at" >= (v_after ->> 0)::timestamptz and ((r."created_at" > (v_after ->> 0)::timestamptz) or (r."created_at" = (v_after ->> 0)::timestamptz and r."id" < (v_after ->> 1)::uuid))))
      order by r."created_at" asc, r."id" desc
      limit v_limit + 1 offset v_offset
    ) r
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'userId', r."user_id", 'role', r."role", 'previousRole', r."previous_role", 'reason', r."reason", 'duration', r."duration"::text, 'status', r.bs_status, 'approvalId', r."approval_id", 'grantedAt', r."granted_at", 'expiresAt', r."expires_at", 'endedAt', r."ended_at", 'createdAt', r."created_at") as j, jsonb_build_array((r."created_at")::text, (r."id")::text) as k
    from (
      select * from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
        and (v_after is null or (r."created_at", r."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by r."created_at" desc, r."id" desc
      limit v_limit + 1 offset v_offset
    ) r
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'userId', r."user_id", 'role', r."role", 'previousRole', r."previous_role", 'reason', r."reason", 'duration', r."duration"::text, 'status', r.bs_status, 'approvalId', r."approval_id", 'grantedAt', r."granted_at", 'expiresAt', r."expires_at", 'endedAt', r."ended_at", 'createdAt', r."created_at") as j, jsonb_build_array((r."created_at")::text, (r."id")::text) as k
    from (
      select * from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
        and (v_after is null or (r."created_at" >= (v_after ->> 0)::timestamptz and ((r."created_at" > (v_after ->> 0)::timestamptz) or (r."created_at" = (v_after ->> 0)::timestamptz and r."id" < (v_after ->> 1)::uuid))))
      order by r."created_at" asc, r."id" desc
      limit v_limit + 1 offset v_offset
    ) r
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'userId', r."user_id", 'role', r."role", 'previousRole', r."previous_role", 'reason', r."reason", 'duration', r."duration"::text, 'status', r.bs_status, 'approvalId', r."approval_id", 'grantedAt', r."granted_at", 'expiresAt', r."expires_at", 'endedAt', r."ended_at", 'createdAt', r."created_at") as j, jsonb_build_array((r."created_at")::text, (r."id")::text) as k
    from (
      select * from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
        and (v_after is null or (r."created_at", r."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by r."created_at" desc, r."id" desc
      limit v_limit + 1 offset v_offset
    ) r
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$$;
revoke execute on function "better_supabase"."list_access_requests"(uuid, jsonb) from public, anon;
grant execute on function "better_supabase"."list_access_requests"(uuid, jsonb) to authenticated, service_role;

-- Tenant isolation (ADR 0099): permissive policies combine with or, so one
-- the app adds would widen the block's. These restrictive policies keep each
-- table to the caller's organizations and what the block's policies grant.
create policy bsb_tenant_scope_select on "better_supabase"."access_requests" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('access_requests.read')) or "user_id" = (select auth.uid()))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."access_requests" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."access_requests" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."access_requests" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));

-- Row audit for the module's tables (blocks.audit.options.blockTables)
create constraint trigger bsb_audit after insert or update or delete on better_supabase.access_requests deferrable initially deferred for each row when (better_supabase.import_run() is null or current_setting('better_supabase.import_audit', true) is distinct from 'summary') execute function better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"access_request","event_prefix":"access_request"}');
