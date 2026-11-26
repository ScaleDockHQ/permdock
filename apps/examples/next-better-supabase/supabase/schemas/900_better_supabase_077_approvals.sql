-- better-supabase module: approvals
-- @bsb-block approvals@6 managed
-- @bsb-hash sha256:2f6e863a1d442f95769495b8bfd070023c600ed160982a964ad076fb7c0cfa82
-- Approval requests with steps per subject type and action: approvers by permission, role, team, user or the requester's manager, a required count, delegation, expiry and reminders. Tenants tighten the configured policies with conditions and a confirm or authorize mode, and an approval is consumed once against a request fingerprint. The final approval runs a state-machine transition or a job.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create table "better_supabase"."approval_requests" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "subject_type" text not null,
  "subject_id" text not null,
  "action" text not null,
  "policy" jsonb not null,
  "step" integer not null default 0 constraint bsb_approval_requests_step_check check ("step" >= 0),
  "status" text not null default 'pending' constraint bsb_approval_requests_status_check check ("status" in ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'consumed')),
  "requested_by" uuid,
  "reason" text constraint bsb_approval_requests_reason_check check ("reason" is null or length("reason") <= 2000),
  "payload" jsonb not null default '{}'::jsonb,
  "expires_at" timestamptz,
  "reminded_at" timestamptz,
  "decided_at" timestamptz,
  "fingerprint" text constraint bsb_approval_requests_fingerprint_check check ("fingerprint" is null or "fingerprint" ~ '^[0-9a-f]{64}$'),
  "consumed_at" timestamptz,
  "created_at" timestamptz not null default now(),
  constraint "bsb_approval_requests_consumed_check" check (("status" = 'consumed') = ("consumed_at" is not null))
);
create unique index "approval_requests_pending_idx" on "better_supabase"."approval_requests" ("subject_type", "subject_id", "action") where "status" = 'pending';
create index "approval_requests_subject_idx" on "better_supabase"."approval_requests" ("subject_type", "subject_id");
create index "approval_requests_tenant_idx" on "better_supabase"."approval_requests" ("tenant_id", "status", "created_at" desc);
alter table "better_supabase"."approval_requests" enable row level security;
revoke all on "better_supabase"."approval_requests" from public, anon, authenticated;
grant select on "better_supabase"."approval_requests" to authenticated;
grant all on "better_supabase"."approval_requests" to service_role;
create policy bsb_approval_requests_read on "better_supabase"."approval_requests"
  for select to authenticated
  using (("tenant_id" in (select better_supabase.tenant_ids_with('approvals.read')) and not "subject_type" in ('support_request')) or "requested_by" = (select auth.uid()));

create table "better_supabase"."approval_decisions" (
  "id" uuid primary key default gen_random_uuid(),
  "request_id" uuid not null references "better_supabase"."approval_requests" ("id") on delete cascade,
  "tenant_id" uuid not null,
  "step" integer not null,
  "approver" uuid,
  "decision" text not null constraint bsb_approval_decisions_decision_check check ("decision" in ('approved', 'rejected', 'delegated')),
  "delegate_to" uuid,
  "comment" text constraint bsb_approval_decisions_comment_check check ("comment" is null or length("comment") <= 2000),
  "created_at" timestamptz not null default clock_timestamp(),
  constraint bsb_approval_decisions_check check (("decision" = 'delegated') = ("delegate_to" is not null)),
  unique ("request_id", "step", "approver")
);
create index "approval_decisions_delegate_idx" on "better_supabase"."approval_decisions" ("delegate_to") where "delegate_to" is not null;
alter table "better_supabase"."approval_decisions" enable row level security;
revoke all on "better_supabase"."approval_decisions" from public, anon, authenticated;
grant select on "better_supabase"."approval_decisions" to authenticated;
grant all on "better_supabase"."approval_decisions" to service_role;
create policy bsb_approval_decisions_read on "better_supabase"."approval_decisions"
  for select to authenticated
  using ("tenant_id" in (select better_supabase.tenant_ids_with('approvals.read')));

create table "better_supabase"."approval_items" (
  "id" uuid primary key default gen_random_uuid(),
  "request_id" uuid not null references "better_supabase"."approval_requests" ("id") on delete cascade,
  "tenant_id" uuid not null,
  "key" text not null constraint bsb_approval_items_key_check check (length("key") >= 1 and length("key") <= 200),
  "label" text constraint bsb_approval_items_label_check check ("label" is null or length("label") <= 500),
  "payload" jsonb not null default '{}'::jsonb,
  "permission" text,
  "depends_on" text[] not null default '{}',
  "status" text not null default 'pending' constraint bsb_approval_items_status_check check ("status" in ('pending', 'approved', 'rejected')),
  "created_type" text,
  "created_id" text,
  "decided_by" uuid,
  "decided_at" timestamptz,
  "created_at" timestamptz not null default now(),
  unique ("request_id", "key"),
  constraint bsb_approval_items_check check (("created_type" is null) = ("created_id" is null))
);
create index "approval_items_tenant_idx" on "better_supabase"."approval_items" ("tenant_id", "status");
alter table "better_supabase"."approval_items" enable row level security;
revoke all on "better_supabase"."approval_items" from public, anon, authenticated;
grant select on "better_supabase"."approval_items" to authenticated;
grant all on "better_supabase"."approval_items" to service_role;
create policy bsb_approval_items_read on "better_supabase"."approval_items"
  for select to authenticated
  using ("tenant_id" in (select better_supabase.tenant_ids_with('approvals.read')));

-- The policy a new request snapshots: the approval_floor rows the app declared
-- (most specific first), else options.policies.
create or replace function "better_supabase"."approval_policy"(subject_type text, action text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    better_supabase.declared_defaults_of('approval_floor', approval_policy.subject_type || ':' || approval_policy.action) -> 0,
    better_supabase.declared_defaults_of('approval_floor', approval_policy.subject_type || ':*') -> 0,
    better_supabase.declared_defaults_of('approval_floor', '*:' || approval_policy.action) -> 0,
    better_supabase.declared_defaults_of('approval_floor', '*:*') -> 0,
    null::jsonb
  )
$$;
revoke execute on function "better_supabase"."approval_policy"(text, text) from public, anon;
grant execute on function "better_supabase"."approval_policy"(text, text) to authenticated, service_role;

create or replace function "better_supabase"."approval_memo_bump"()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform better_supabase.memo_set('approvals.gen', (coalesce(better_supabase.memo_get('approvals.gen'), '0')::bigint + 1)::text);
  return null;
end;
$$;
revoke execute on function "better_supabase"."approval_memo_bump"() from public, anon, authenticated;
create trigger "bsb_approval_memo" after insert or update or delete on "public"."organization_memberships"
  for each statement execute function "better_supabase"."approval_memo_bump"();
create trigger "bsb_approval_memo" after insert or update or delete on "better_supabase"."team_members"
  for each statement execute function "better_supabase"."approval_memo_bump"();

create or replace function "better_supabase"."approval_fact"(tenant uuid, kind text, value text, requester uuid default null)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_key text := 'approvals.f' || md5(format('%s|%s|%s|%s|%s', v_me, approval_fact.tenant, approval_fact.kind, approval_fact.value, approval_fact.requester));
  v_stamp text := statement_timestamp()::text || '/' || coalesce(better_supabase.memo_get('approvals.gen'), '0');
  v_hit text := better_supabase.memo_slot_get(v_key);
  v_result boolean;
begin
  if v_hit is not null and split_part(v_hit, '|', 1) = v_stamp then
    return split_part(v_hit, '|', 2) = 't';
  end if;
  v_result := coalesce(case approval_fact.kind
    when 'role' then exists (
      select 1 from "public"."organization_memberships" m
      where m."organization_id" = approval_fact.tenant and m."user_id" = v_me and m."role" = approval_fact.value
    )
    when 'team' then exists (select 1 from "better_supabase"."team_members" tm where tm."team_id"::text = approval_fact.value and tm."user_id" = v_me)
    when 'manager' then false
    else false
  end, false);
  perform better_supabase.memo_slot_set(v_key, v_stamp || '|' || case when v_result then 't' else 'f' end);
  return v_result;
end;
$$;
revoke execute on function "better_supabase"."approval_fact"(uuid, text, text, uuid) from public, anon, authenticated;

-- Whether the caller may decide the request's current step: a named user,
-- a holder of the permission, a member with the role or in the team, or a
-- delegate. The requester can't, unless the policy allows self-approval.
create or replace function "better_supabase"."approval_eligible"(request "better_supabase"."approval_requests")
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_req "better_supabase"."approval_requests"%rowtype := approval_eligible.request;
  v_step jsonb;
  v_approvers jsonb;
  v_me uuid := auth.uid();
begin
  if v_req."id" is null or v_me is null or v_req."status" <> 'pending' then
    return false;
  end if;
  if exists (
    select 1 from "better_supabase"."approval_decisions" x
    where x."request_id" = v_req."id" and x."step" = v_req."step" and x."approver" = v_me
  ) then
    return false;
  end if;
  if coalesce(v_req."policy" -> 'excludedUserIds', '[]'::jsonb) ? v_me::text then
    return false;
  end if;
  if v_me = v_req."requested_by" then
    if v_req."policy" ->> 'mode' = 'confirm' then
      return true;
    end if;
    if not coalesce((v_req."policy" ->> 'selfApproval')::boolean, false) then
      return false;
    end if;
  end if;
  if v_req."subject_type" = 'support_request' then
    return "better_supabase"."support_request_approvable"(v_req."subject_id"::uuid);
  end if;
  v_step := v_req."policy" -> 'steps' -> v_req."step";
  v_approvers := v_step -> 'approvers';
  if ((coalesce(v_approvers -> 'users', '[]'::jsonb) ? v_me::text)
    or (v_approvers ->> 'permission' is not null and coalesce(better_supabase.can('tenant', v_req."tenant_id", v_approvers ->> 'permission'), false))
    or (v_approvers ->> 'role' is not null and "better_supabase"."approval_fact"(v_req."tenant_id", 'role', v_approvers ->> 'role', null))
    or (v_approvers ->> 'team' is not null and "better_supabase"."approval_fact"(v_req."tenant_id", 'team', v_approvers ->> 'team', null))) then
    return true;
  end if;
  if coalesce((v_step ->> 'escalated')::boolean, false) then
    v_approvers := v_step -> 'escalateTo';
    if ((coalesce(v_approvers -> 'users', '[]'::jsonb) ? v_me::text)
    or (v_approvers ->> 'permission' is not null and coalesce(better_supabase.can('tenant', v_req."tenant_id", v_approvers ->> 'permission'), false))
    or (v_approvers ->> 'role' is not null and "better_supabase"."approval_fact"(v_req."tenant_id", 'role', v_approvers ->> 'role', null))
    or (v_approvers ->> 'team' is not null and "better_supabase"."approval_fact"(v_req."tenant_id", 'team', v_approvers ->> 'team', null))) then
      return true;
    end if;
  end if;
  return exists (
      select 1 from "better_supabase"."approval_decisions" x
      where x."request_id" = v_req."id" and x."step" = v_req."step"
        and x."decision" = 'delegated' and x."delegate_to" = v_me
    );
end;
$$;
revoke execute on function "better_supabase"."approval_eligible"("better_supabase"."approval_requests") from public, anon;
grant execute on function "better_supabase"."approval_eligible"("better_supabase"."approval_requests") to authenticated, service_role;

create or replace function "better_supabase"."approval_eligible"(request_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = approval_eligible.request_id;
  if not found then
    return false;
  end if;
  return "better_supabase"."approval_eligible"(v_req);
end;
$$;
revoke execute on function "better_supabase"."approval_eligible"(uuid) from public, anon;
grant execute on function "better_supabase"."approval_eligible"(uuid) to authenticated, service_role;

-- The pending requests the caller may decide, as a set, for a policy or a list
-- (`id in (select "better_supabase"."approval_eligible_ids"())`): Postgres evaluates the set once per
-- statement, not once per row. It applies the rules of approval_eligible as
-- joins over the pending requests (a permission is checked once per tenant and
-- permission pair), and a parity test keeps the two
-- in step. Pass a tenant to read one tenant's.
create or replace function "better_supabase"."approval_eligible_ids"(tenant uuid default null)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  with base as (
    select r.*, (select auth.uid()) as bsb_me from "better_supabase"."approval_requests" r
    where r."status" = 'pending' and (select auth.uid()) is not null
      and (approval_eligible_ids.tenant is null or r."tenant_id" = approval_eligible_ids.tenant)
  ),
  q as (
    select b.*, b."policy" -> 'steps' -> b."step" as bsb_step from base b
  ),
  needs as materialized (
    select distinct q."tenant_id" as t, s.ap ->> 'permission' as p
    from q, lateral (values ((q.bsb_step -> 'approvers'), (case when coalesce((q.bsb_step ->> 'escalated')::boolean, false) then (q.bsb_step -> 'escalateTo') end))) as s(ap)
    where s.ap ->> 'permission' is not null
  ),
  granted as materialized (
    select n.t, n.p from needs n
    where coalesce(better_supabase.can('tenant', n.t, n.p), false)
  )
  select q."id" from q
  where not exists (select 1 from "better_supabase"."approval_decisions" x where x."request_id" = q."id" and x."step" = q."step" and x."approver" = q.bsb_me)
    and not (coalesce(q."policy" -> 'excludedUserIds', '[]'::jsonb) ? q.bsb_me::text)
    and ((q.bsb_me = q."requested_by" and q."policy" ->> 'mode' = 'confirm')
      or ((q.bsb_me is distinct from q."requested_by" or coalesce((q."policy" ->> 'selfApproval')::boolean, false))
        and (case when q."subject_type" = 'support_request' then ("better_supabase"."support_request_approvable"(q."subject_id"::uuid))
          else (((coalesce((q.bsb_step -> 'approvers') -> 'users', '[]'::jsonb) ? q.bsb_me::text)
    or ((q.bsb_step -> 'approvers') ->> 'permission' is not null and exists (select 1 from granted g where g.t is not distinct from q."tenant_id" and g.p = (q.bsb_step -> 'approvers') ->> 'permission'))
    or ((q.bsb_step -> 'approvers') ->> 'role' is not null and exists (
      select 1 from "public"."organization_memberships" mm
      where mm."organization_id" = q."tenant_id" and mm."user_id" = q.bsb_me and mm."role" = (q.bsb_step -> 'approvers') ->> 'role'
    ))
    or ((q.bsb_step -> 'approvers') ->> 'team' is not null and exists (select 1 from "better_supabase"."team_members" tm where tm."team_id"::text = (q.bsb_step -> 'approvers') ->> 'team' and tm."user_id" = q.bsb_me)))
    or (coalesce((q.bsb_step ->> 'escalated')::boolean, false) and ((coalesce((q.bsb_step -> 'escalateTo') -> 'users', '[]'::jsonb) ? q.bsb_me::text)
    or ((q.bsb_step -> 'escalateTo') ->> 'permission' is not null and exists (select 1 from granted g where g.t is not distinct from q."tenant_id" and g.p = (q.bsb_step -> 'escalateTo') ->> 'permission'))
    or ((q.bsb_step -> 'escalateTo') ->> 'role' is not null and exists (
      select 1 from "public"."organization_memberships" mm
      where mm."organization_id" = q."tenant_id" and mm."user_id" = q.bsb_me and mm."role" = (q.bsb_step -> 'escalateTo') ->> 'role'
    ))
    or ((q.bsb_step -> 'escalateTo') ->> 'team' is not null and exists (select 1 from "better_supabase"."team_members" tm where tm."team_id"::text = (q.bsb_step -> 'escalateTo') ->> 'team' and tm."user_id" = q.bsb_me))))
    or exists (select 1 from "better_supabase"."approval_decisions" x where x."request_id" = q."id" and x."step" = q."step" and x."decision" = 'delegated' and x."delegate_to" = q.bsb_me)) end)));
end;
$$;
revoke execute on function "better_supabase"."approval_eligible_ids"(uuid) from public, anon;
grant execute on function "better_supabase"."approval_eligible_ids"(uuid) to authenticated, service_role;

-- Notifies the current step's approvers (requested, reminder), its fallback
-- approvers (escalated), a delegate (delegated) or the requester (approved,
-- rejected, expired).
create or replace function "better_supabase"."approval_notify"(request_id uuid, kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_approvers jsonb;
  v_permission text;
  v_recipients uuid[] := '{}';
  v_claims text;
begin
  null;
end;
$$;
revoke execute on function "better_supabase"."approval_notify"(uuid, text) from public, anon, authenticated;

-- Runs what the final approval unlocks: the policy's state-machine
-- transition or job, or the grant or decision of the module that filed it.
create or replace function "better_supabase"."approval_finalize"(request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_run jsonb;
begin
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = approval_finalize.request_id;
  v_run := v_req."policy" -> 'run';
  if v_req."subject_type" = 'support_request' then
    perform "better_supabase"."apply_support_approval"(v_req."subject_id"::uuid, auth.uid());
  end if;
  if v_req."subject_type" = 'access_request' then
    perform "better_supabase"."grant_access_request"(v_req."subject_id"::uuid);
  end if;
  perform better_supabase.audit_event(
    event_type => 'approval.approved',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'approved' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  perform "better_supabase"."approval_notify"(v_req."id", 'approved');
end;
$$;
revoke execute on function "better_supabase"."approval_finalize"(uuid) from public, anon, authenticated;

-- Files a request under an explicit policy snapshot. request_approval and
-- the access-requests module call it after their own checks. requested_by
-- defaults to the caller. on_behalf names requested_by as the subject's
-- owner: null then means an owner without a login, never the caller, so a
-- member who files for that owner can still decide the request.

create or replace function "better_supabase"."open_approval"(tenant uuid, subject_type text, subject_id text, action text, policy jsonb, reason text, payload jsonb, requested_by uuid default null, on_behalf boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_policy jsonb := open_approval.policy;
  v_requester uuid := case when open_approval.on_behalf then open_approval.requested_by else coalesce(open_approval.requested_by, auth.uid()) end;
begin
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_request"(uuid, text, text, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text, $3::text, $4::text)', v_hook::oid::regproc)
        using open_approval.tenant, open_approval.subject_type, open_approval.subject_id, open_approval.action;
    end if;
  end;
  if exists (select 1 from jsonb_array_elements(coalesce(v_policy -> 'steps', '[]'::jsonb)) e where e.value -> 'required' = '"all"'::jsonb) then
    v_policy := jsonb_set(v_policy, '{steps}', (
      select jsonb_agg(case when e.value -> 'required' = '"all"'::jsonb
        then e.value || jsonb_build_object('approvers', jsonb_build_object('users', h.users), 'required', jsonb_array_length(h.users), 'all', true, 'permission', e.value -> 'approvers' ->> 'permission')
        else e.value end order by e.ordinality)
      from jsonb_array_elements(v_policy -> 'steps') with ordinality e
      left join lateral (
        select coalesce(jsonb_agg(distinct to_jsonb(u.id::text)), '[]'::jsonb) as users
        from (select h.u from permdock.permitted_organization_users((e.value -> 'approvers' ->> 'permission'), open_approval.tenant) as h(u)) as u(id)
        where u.id is not null and (u.id is distinct from v_requester or coalesce((v_policy ->> 'selfApproval')::boolean, false))
          and not (coalesce(v_policy -> 'excludedUserIds', '[]'::jsonb) ? u.id::text)
      ) h on e.value -> 'required' = '"all"'::jsonb
    ));
    if exists (select 1 from jsonb_array_elements(v_policy -> 'steps') e where e.value -> 'required' = '0'::jsonb) then
      raise exception 'nobody holds the permission a step asks every holder of' using errcode = '22023', hint = 'APPROVAL_APPROVERS_EMPTY';
    end if;
  end if;
  insert into "better_supabase"."approval_requests" ("tenant_id", "subject_type", "subject_id", "action", "policy", "requested_by", "reason", "payload", "expires_at")
  values (open_approval.tenant, open_approval.subject_type, open_approval.subject_id, open_approval.action, v_policy, v_requester, open_approval.reason, coalesce(open_approval.payload, '{}'::jsonb),
    case when open_approval.policy ->> 'expiresIn' is not null then now() + (open_approval.policy ->> 'expiresIn')::interval end)
  on conflict ("subject_type", "subject_id", "action") where "status" = 'pending' do nothing
  returning * into v_req;
  if not found then
    raise exception 'this record already has a pending request for that action' using errcode = '23505', hint = 'APPROVAL_PENDING';
  end if;
  perform better_supabase.audit_event(
    event_type => 'approval.requested',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'requested' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  perform "better_supabase"."approval_notify"(v_req."id", 'requested');
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_request"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_req."id";
    end if;
  end;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at", 'fields', jsonb_build_object('token', v_req."token", 'body', v_req."body"));
end;
$$;
revoke execute on function "better_supabase"."open_approval"(uuid, text, text, text, jsonb, text, jsonb, uuid, boolean) from public, anon, authenticated;

-- Closes the pending request for a subject that its own module decided
-- (decide_ai_tool_approval, approve_support_request) without running the
-- module again. A request that is no longer pending is left as it is.
create or replace function "better_supabase"."approval_settle"(subject_type text, subject_id text, action text, decision text, approver uuid, comment text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  select * into v_req from "better_supabase"."approval_requests" r
  where r."subject_type" = approval_settle.subject_type and r."subject_id" = approval_settle.subject_id
    and r."action" = approval_settle.action and r."status" = 'pending'
  for update;
  if not found then
    return;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", approval_settle.decision;
    end if;
  end;
  insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision", "comment")
  values (v_req."id", v_req."tenant_id", v_req."step", approval_settle.approver, approval_settle.decision, approval_settle.comment)
  on conflict do nothing;
  update "better_supabase"."approval_requests" r set "status" = approval_settle.decision, "decided_at" = now()
    where r."id" = v_req."id" returning * into v_req;
  if approval_settle.decision = 'approved' then
    perform better_supabase.audit_event(
    event_type => 'approval.approved',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'approved' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  else
    perform better_supabase.audit_event(
    event_type => 'approval.rejected',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'rejected' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  end if;
  perform "better_supabase"."approval_notify"(v_req."id", approval_settle.decision);
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_req."status";
    end if;
  end;
end;
$$;
revoke execute on function "better_supabase"."approval_settle"(text, text, text, text, uuid, text) from public, anon, authenticated;



-- The policy a request snapshots: options.policies, as tenant policies are off.
create or replace function "better_supabase"."approval_effective_policy"(tenant uuid, subject_type text, action text, subject jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select "better_supabase"."approval_policy"(approval_effective_policy.subject_type, approval_effective_policy.action)
$$;
revoke execute on function "better_supabase"."approval_effective_policy"(uuid, text, text, jsonb) from public, anon, authenticated;

-- What a request for the subject type and action would need right now, with
-- subject as the request payload the tenant policies' conditions read; null
-- when nothing is required.
create or replace function "better_supabase"."approval_requirement"(tenant uuid, subject_type text, action text, subject jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_policy jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', approval_requirement.tenant, 'approvals.request'), false)) then
    raise exception 'checking an approval requirement needs approvals.request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  v_policy := "better_supabase"."approval_effective_policy"(approval_requirement.tenant, approval_requirement.subject_type, approval_requirement.action, approval_requirement.subject);
  if v_policy is null or not (coalesce(v_policy ->> 'mode', 'authorize') = 'confirm' or jsonb_array_length(coalesce(v_policy -> 'steps', '[]'::jsonb)) > 0) then
    return null;
  end if;
  return v_policy || jsonb_build_object('mode', coalesce(v_policy ->> 'mode', 'authorize'));
end;
$$;
revoke execute on function "better_supabase"."approval_requirement"(uuid, text, text, jsonb) from public, anon;
grant execute on function "better_supabase"."approval_requirement"(uuid, text, text, jsonb) to authenticated, service_role;

-- An app's own policy for one request, tightened by the policy the request
-- would get anyway (base, null when there is none): steps add up, the stricter
-- mode wins, self-approval needs both to allow it and the shorter expiry
-- applies. It never loosens base.
create or replace function "better_supabase"."approval_policy_tighten"(base jsonb, own jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_step jsonb;
  v_who jsonb;
  v_mode text := coalesce(approval_policy_tighten.own ->> 'mode', 'authorize');
  v_steps jsonb := coalesce(approval_policy_tighten.own -> 'steps', '[]'::jsonb);
  v_level integer;
  v_expires interval;
begin
  if jsonb_typeof(approval_policy_tighten.own) is distinct from 'object'
    or jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) > 20
    or v_mode not in ('confirm', 'authorize')
    or (approval_policy_tighten.own ? 'selfApproval' and jsonb_typeof(approval_policy_tighten.own -> 'selfApproval') <> 'boolean')
    or (approval_policy_tighten.own ? 'managerOf' and true)
    or (approval_policy_tighten.own ->> 'expiresIn' is not null and (approval_policy_tighten.own ->> 'expiresIn')::interval <= interval '0') then
    raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
  end if;
  for v_step in select * from jsonb_array_elements(v_steps) loop
    if jsonb_typeof(v_step) <> 'object' then
      raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
    end if;
    for v_who in select a.w from (values (v_step -> 'approvers', true), (v_step -> 'escalateTo', v_step ? 'escalateTo')) a(w, checked) where a.checked loop
      if jsonb_typeof(v_who) is distinct from 'object'
        or not (v_who ?| array['permission', 'role', 'team', 'users', 'manager', 'decider'])
        or (v_who ? 'manager' and true)
        or (v_who ? 'decider' and v_who -> 'decider' <> 'true'::jsonb)
        or (v_who ? 'users' and (jsonb_typeof(v_who -> 'users') <> 'array'
          or exists (select 1 from jsonb_array_elements(v_who -> 'users') u
            where jsonb_typeof(u) <> 'string' or u #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))) then
        raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
      end if;
    end loop;
    if (v_step ? 'required' and v_step -> 'required' <> '"all"'::jsonb and (jsonb_typeof(v_step -> 'required') <> 'number' or (v_step ->> 'required')::numeric < 1
        or (v_step ->> 'required')::numeric <> trunc((v_step ->> 'required')::numeric)))
      or (v_step -> 'required' = '"all"'::jsonb and (v_step -> 'approvers') - 'permission' <> '{}'::jsonb
        and ((v_step -> 'approvers') - 'users' <> '{}'::jsonb or jsonb_array_length(v_step -> 'approvers' -> 'users') = 0))
      or (jsonb_typeof(v_step -> 'required') = 'number' and (v_step -> 'approvers') - 'users' = '{}'::jsonb
        and (v_step ->> 'required')::numeric > jsonb_array_length(v_step -> 'approvers' -> 'users'))
      or ((v_step ? 'escalateAfter') <> (v_step ? 'escalateTo'))
      or (v_step ? 'escalateAfter' and (jsonb_typeof(v_step -> 'escalateAfter') <> 'string' or (v_step ->> 'escalateAfter')::interval <= interval '0')) then
      raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
    end if;
  end loop;
  v_steps := (select coalesce(jsonb_agg(case when s -> 'required' = '"all"'::jsonb and (s -> 'approvers') ? 'users'
    then jsonb_set(s, '{required}', to_jsonb(jsonb_array_length(s -> 'approvers' -> 'users'))) || '{"all": true}'::jsonb else s - 'all' end order by o), '[]'::jsonb)
    from jsonb_array_elements(v_steps) with ordinality e(s, o));
  v_expires := (approval_policy_tighten.own ->> 'expiresIn')::interval;
  if approval_policy_tighten.base is null then
    return jsonb_build_object(
      'steps', v_steps,
      'selfApproval', coalesce((approval_policy_tighten.own ->> 'selfApproval')::boolean, false),
      'expiresIn', v_expires::text, 'run', null
    ) || case when v_mode = 'confirm' then '{"mode": "confirm"}'::jsonb else '{}'::jsonb end
      || case when approval_policy_tighten.own ? 'managerOf' then jsonb_build_object('managerOf', approval_policy_tighten.own -> 'managerOf') else '{}'::jsonb end;
  end if;
  v_level := greatest(
    case when coalesce(approval_policy_tighten.base ->> 'mode', 'authorize') = 'authorize' and jsonb_array_length(coalesce(approval_policy_tighten.base -> 'steps', '[]'::jsonb)) > 0 then 2 when coalesce(approval_policy_tighten.base ->> 'mode', 'authorize') = 'confirm' then 1 else 0 end,
    case when v_mode = 'authorize' and jsonb_array_length(v_steps) > 0 then 2 when v_mode = 'confirm' then 1 else 0 end
  );
  return approval_policy_tighten.base || jsonb_build_object(
    'steps', coalesce(approval_policy_tighten.base -> 'steps', '[]'::jsonb) || v_steps,
    'selfApproval', coalesce((approval_policy_tighten.base ->> 'selfApproval')::boolean, false) and coalesce((approval_policy_tighten.own ->> 'selfApproval')::boolean, false),
    'expiresIn', least((approval_policy_tighten.base ->> 'expiresIn')::interval, v_expires)::text,
    'mode', case when v_level = 1 then 'confirm' else 'authorize' end
  ) || case when approval_policy_tighten.own ? 'managerOf' then jsonb_build_object('managerOf', approval_policy_tighten.own -> 'managerOf') else '{}'::jsonb end;
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
end;
$$;
revoke execute on function "better_supabase"."approval_policy_tighten"(jsonb, jsonb) from public, anon, authenticated;
-- fingerprint: the hex SHA-256 of the request's canonical form, which
-- consume_approval checks before the approved action runs. The service role
-- may pass its own policy, which only tightens the configured and stored ones,
-- and requested_by, the user it files for, who can't approve it.
create or replace function "better_supabase"."request_approval"(tenant uuid, subject_type text, subject_id text, action text, reason text default null, payload jsonb default '{}'::jsonb, fields jsonb default null, fingerprint text default null, policy jsonb default null, requested_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy jsonb := "better_supabase"."approval_effective_policy"(request_approval.tenant, request_approval.subject_type, request_approval.action, coalesce(request_approval.payload, '{}'::jsonb));
  v_service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  v_result jsonb;
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if request_approval.policy is not null and not v_service then
    raise exception 'only the service role files a request under its own policy' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if request_approval.requested_by is not null and not v_service and request_approval.requested_by is distinct from auth.uid() then
    raise exception 'only the service role files a request for another user' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if request_approval.policy is not null then
    v_policy := "better_supabase"."approval_policy_tighten"(v_policy, request_approval.policy);
  end if;
  if v_policy is null then
    raise exception 'no approval policy for this subject type and action' using errcode = '22023', hint = 'APPROVAL_POLICY_UNKNOWN';
  end if;
  if not (v_service or (coalesce(better_supabase.can('tenant', request_approval.tenant, 'approvals.request'), false) and true)) then
    raise exception 'not allowed to request approval for this record' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if not (coalesce(v_policy ->> 'mode', 'authorize') = 'confirm' or jsonb_array_length(coalesce(v_policy -> 'steps', '[]'::jsonb)) > 0) then
    raise exception 'no approval is required for this request' using errcode = '22023', hint = 'APPROVAL_NOT_REQUIRED';
  end if;
  if request_approval.fingerprint is not null and request_approval.fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'fingerprint must be a lowercase hex SHA-256' using errcode = '22023', hint = 'APPROVAL_FINGERPRINT_INVALID';
  end if;
  v_result := "better_supabase"."open_approval"(request_approval.tenant, request_approval.subject_type, request_approval.subject_id, request_approval.action, v_policy, request_approval.reason, request_approval.payload, coalesce(request_approval.requested_by, auth.uid()));
  if request_approval.fingerprint is not null then
    update "better_supabase"."approval_requests" x set "fingerprint" = request_approval.fingerprint
    where x."id" = (v_result ->> 'id')::uuid and x."status" = 'pending';
  end if;

  update "better_supabase"."approval_requests" x set "token" = case when request_approval.fields ? 'token' then r."token" else x."token" end, "body" = case when request_approval.fields ? 'body' then r."body" else x."body" end
  from jsonb_populate_record(null::"better_supabase"."approval_requests", (select coalesce(jsonb_object_agg(e.key, e.value), '{}') from jsonb_each(request_approval.fields) e where e.key in ('token', 'body'))) r
  where x."id" = (v_result ->> 'id')::uuid
  returning x.* into v_req;
  select * into v_req from "better_supabase"."approval_requests" x where x."id" = (v_result ->> 'id')::uuid;
  if found then
    return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at", 'fields', jsonb_build_object('token', v_req."token", 'body', v_req."body"));
  end if;
  return v_result;
end;
$$;
revoke execute on function "better_supabase"."request_approval"(uuid, text, text, text, text, jsonb, jsonb, text, jsonb, uuid) from public, anon;
grant execute on function "better_supabase"."request_approval"(uuid, text, text, text, text, jsonb, jsonb, text, jsonb, uuid) to authenticated, service_role;

-- Uses an approved request once, right before the approved action runs. The
-- fingerprint must match the one the request was filed with, so an approval
-- never covers a request that changed after it was decided.
create or replace function "better_supabase"."consume_approval"(request_id uuid, fingerprint text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = consume_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_req."requested_by" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_req."tenant_id", 'approvals.manage'), false)) then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."consumed_at" is not null then
    raise exception 'this approval was already used' using errcode = '22023', hint = 'APPROVAL_CONSUMED';
  end if;
  if v_req."status" <> 'approved' then
    raise exception 'this request is not approved' using errcode = '22023', hint = 'APPROVAL_NOT_APPROVED';
  end if;
  if v_req."fingerprint" is distinct from consume_approval.fingerprint then
    raise exception 'the request changed after it was approved; ask for approval again' using errcode = '22023', hint = 'APPROVAL_FINGERPRINT_MISMATCH';
  end if;
  update "better_supabase"."approval_requests" r set "status" = 'consumed', "consumed_at" = now()
    where r."id" = v_req."id" returning * into v_req;
  perform better_supabase.audit_event(
    event_type => 'approval.consumed',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'consumed' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at", 'fields', jsonb_build_object('token', v_req."token", 'body', v_req."body"));
end;
$$;
revoke execute on function "better_supabase"."consume_approval"(uuid, text) from public, anon;
grant execute on function "better_supabase"."consume_approval"(uuid, text) to authenticated, service_role;

-- Approves or rejects the current step. Enough approvals move the request
-- to the next step, and the last step runs the policy's action. A step marked
-- all needs an approval from each named approver or their delegate until it
-- escalates. The service
-- role decides for the user in decided_by, who is recorded as the approver;
-- it skips the approver check, never the requester's.

create or replace function "better_supabase"."decide_approval"(request_id uuid, decision text, comment text default null, decided_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_count integer;
  v_service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  v_actor uuid := coalesce(decide_approval.decided_by, auth.uid());
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if decide_approval.decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023', hint = 'APPROVAL_DECISION_INVALID';
  end if;
  if decide_approval.decided_by is not null and not v_service and decide_approval.decided_by is distinct from auth.uid() then
    raise exception 'only the service role decides for another user' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = decide_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  if v_req."expires_at" is not null and v_req."expires_at" <= now() then
    raise exception 'this request has expired' using errcode = '22023', hint = 'APPROVAL_EXPIRED';
  end if;
  if exists (select 1 from "better_supabase"."approval_items" x where x."request_id" = v_req."id") then
    raise exception 'this request has items; use decide_approval_items' using errcode = '22023', hint = 'APPROVAL_ITEMS_REQUIRED';
  end if;
  if v_service then
    if v_actor is not null and v_actor = v_req."requested_by" and coalesce(v_req."policy" ->> 'mode', 'authorize') <> 'confirm'
      and not coalesce((v_req."policy" ->> 'selfApproval')::boolean, false) then
      raise exception 'the requester can''t decide their own request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
    end if;
    if v_actor is not null and coalesce(v_req."policy" -> 'excludedUserIds', '[]'::jsonb) ? v_actor::text then
      raise exception 'this user is left out of deciding this request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
    end if;
    if v_actor is not null and exists (
      select 1 from "better_supabase"."approval_decisions" x
      where x."request_id" = v_req."id" and x."step" = v_req."step" and x."approver" = v_actor
    ) then
      raise exception 'this user already decided this step' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
    end if;
  elsif not "better_supabase"."approval_eligible"(v_req."id") then
    raise exception 'not an approver for this step' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", decide_approval.decision;
    end if;
  end;
  insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision", "comment")
  values (v_req."id", v_req."tenant_id", v_req."step", v_actor, decide_approval.decision, decide_approval.comment);
  if decide_approval.decision = 'rejected' then
    update "better_supabase"."approval_requests" r set "status" = 'rejected', "decided_at" = now()
      where r."id" = v_req."id" returning * into v_req;
    perform better_supabase.audit_event(
    event_type => 'approval.rejected',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'rejected' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
    perform "better_supabase"."approval_notify"(v_req."id", 'rejected');
    if v_req."subject_type" = 'support_request' then
      perform "better_supabase"."close_support_request"(v_req."subject_id"::uuid);
    end if;
  else
    select count(*) into v_count from "better_supabase"."approval_decisions" x
      where x."request_id" = v_req."id" and x."step" = v_req."step" and x."decision" = 'approved';
    if v_req."policy" ->> 'mode' = 'confirm' and v_req."requested_by" = v_actor then
      update "better_supabase"."approval_requests" r set "status" = 'approved', "decided_at" = now()
        where r."id" = v_req."id" returning * into v_req;
      perform "better_supabase"."approval_finalize"(v_req."id");
    elsif (case when coalesce((v_req."policy" -> 'steps' -> v_req."step" ->> 'all')::boolean, false)
        and not coalesce((v_req."policy" -> 'steps' -> v_req."step" ->> 'escalated')::boolean, false)
      then jsonb_array_length(coalesce(v_req."policy" -> 'steps' -> v_req."step" -> 'approvers' -> 'users', '[]'::jsonb)) > 0
        and not exists (
          select 1 from jsonb_array_elements_text(v_req."policy" -> 'steps' -> v_req."step" -> 'approvers' -> 'users') u(id)
          where not exists (
            select 1 from "better_supabase"."approval_decisions" x
            where x."request_id" = v_req."id" and x."step" = v_req."step" and x."decision" = 'approved'
              and (x."approver" = u.id::uuid or exists (
                select 1 from "better_supabase"."approval_decisions" y
                where y."request_id" = x."request_id" and y."step" = x."step" and y."decision" = 'delegated'
                  and y."approver" = u.id::uuid and y."delegate_to" = x."approver"
              ))
          )
        )
      else v_count >= coalesce((v_req."policy" -> 'steps' -> v_req."step" ->> 'required')::integer, 1) end) then
      if v_req."step" + 1 >= jsonb_array_length(v_req."policy" -> 'steps') then
        update "better_supabase"."approval_requests" r set "status" = 'approved', "decided_at" = now()
          where r."id" = v_req."id" returning * into v_req;
        perform "better_supabase"."approval_finalize"(v_req."id");
      else
        update "better_supabase"."approval_requests" r set "step" = r."step" + 1, "reminded_at" = null
          where r."id" = v_req."id" returning * into v_req;
        perform "better_supabase"."approval_notify"(v_req."id", 'requested');
      end if;
    end if;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_req."status";
    end if;
  end;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at", 'fields', jsonb_build_object('token', v_req."token", 'body', v_req."body"));
end;
$$;
revoke execute on function "better_supabase"."decide_approval"(uuid, text, text, uuid) from public, anon;
grant execute on function "better_supabase"."decide_approval"(uuid, text, text, uuid) to authenticated, service_role;

-- Files a request that asks for several things. Each item carries its own
-- permission and may depend on items filed before it. request_approval
-- checks the caller, the policy and the record, so an item request is filed
-- under the same rules as any other, and the items are written in the same
-- transaction.
create or replace function "better_supabase"."request_approval_items"(tenant uuid, subject_type text, subject_id text, action text, items jsonb, reason text default null, payload jsonb default '{}'::jsonb, fingerprint text default null, policy jsonb default null, requested_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_result jsonb;
  v_item jsonb;
  v_key text;
  v_seen text[] := '{}';
  v_after text[];
  v_depends text[];
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if jsonb_typeof(request_approval_items.items) is distinct from 'array' or jsonb_array_length(request_approval_items.items) = 0 then
    raise exception 'items must be a non-empty array' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
  end if;
  if jsonb_array_length(request_approval_items.items) > 200 then
    raise exception 'a request takes at most 200 items' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
  end if;
  if request_approval_items.subject_type in ('support_request') then
    raise exception 'the module that filed this request decides it, so it takes no items' using errcode = '22023', hint = 'APPROVAL_ITEMS_UNSUPPORTED';
  end if;
  for v_item in select e.value from jsonb_array_elements(request_approval_items.items) e loop
    if jsonb_typeof(v_item) is distinct from 'object' or jsonb_typeof(v_item -> 'key') is distinct from 'string' or length(btrim(v_item ->> 'key')) not between 1 and 200 then
      raise exception 'each item needs a key of 1 to 200 characters' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
    end if;
    v_key := v_item ->> 'key';
    if v_key = any(v_seen) then
      raise exception 'item keys must be unique' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
    end if;
    if v_item ? 'dependsOn' and jsonb_typeof(v_item -> 'dependsOn') is distinct from 'array' then
      raise exception 'dependsOn must be an array of item keys' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
    end if;
    v_depends := array(select jsonb_array_elements_text(coalesce(v_item -> 'dependsOn', '[]'::jsonb)));
    if exists (select 1 from unnest(v_depends) dep where dep <> all(v_seen)) then
      raise exception 'an item depends only on items listed before it' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
    end if;
    v_seen := v_seen || v_key;
  end loop;
  v_result := "better_supabase"."request_approval"(
    tenant => request_approval_items.tenant,
    subject_type => request_approval_items.subject_type,
    subject_id => request_approval_items.subject_id,
    action => request_approval_items.action,
    reason => request_approval_items.reason,
    payload => request_approval_items.payload,
    fingerprint => request_approval_items.fingerprint,
    policy => request_approval_items.policy,
    requested_by => request_approval_items.requested_by
  );
  insert into "better_supabase"."approval_items" ("request_id", "tenant_id", "key", "label", "payload", "permission", "depends_on")
  select (v_result ->> 'id')::uuid, request_approval_items.tenant, e.value ->> 'key', e.value ->> 'label',
    case when jsonb_typeof(e.value -> 'payload') = 'object' then e.value -> 'payload' else '{}'::jsonb end,
    nullif(e.value ->> 'permission', ''),
    array(select jsonb_array_elements_text(coalesce(e.value -> 'dependsOn', '[]'::jsonb)))
  from jsonb_array_elements(request_approval_items.items) with ordinality e(value, position)
  order by e.position;
  return v_result || jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = (v_result ->> 'id')::uuid
    ), '[]'::jsonb));
end;
$$;
revoke execute on function "better_supabase"."request_approval_items"(uuid, text, text, text, jsonb, text, jsonb, text, jsonb, uuid) from public, anon;
grant execute on function "better_supabase"."request_approval_items"(uuid, text, text, text, jsonb, text, jsonb, text, jsonb, uuid) to authenticated, service_role;

-- Approves or rejects items of a pending request. An item with a permission
-- needs the caller to hold it; one without follows the step's approvers. An
-- item can't be approved while an item it depends on is pending or rejected,
-- and rejecting an item rejects the pending items that depend on it. The
-- request settles when no item is pending: approved when any item was
-- approved, rejected otherwise. The service role decides for the user in
-- decided_by, who is recorded on the items.
create or replace function "better_supabase"."decide_approval_items"(request_id uuid, decisions jsonb, decided_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_item "better_supabase"."approval_items"%rowtype;
  v_each jsonb;
  v_decision text;
  v_service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  v_actor uuid := coalesce(decide_approval_items.decided_by, auth.uid());
  v_pending integer;
  v_approved integer;
  v_outcome text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if jsonb_typeof(decide_approval_items.decisions) is distinct from 'array' or jsonb_array_length(decide_approval_items.decisions) = 0 then
    raise exception 'decisions must be a non-empty array' using errcode = '22023', hint = 'APPROVAL_DECISION_INVALID';
  end if;
  if decide_approval_items.decided_by is not null and not v_service and decide_approval_items.decided_by is distinct from auth.uid() then
    raise exception 'only the service role decides for another user' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = decide_approval_items.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  if v_req."expires_at" is not null and v_req."expires_at" <= now() then
    raise exception 'this request has expired' using errcode = '22023', hint = 'APPROVAL_EXPIRED';
  end if;
  if not exists (select 1 from "better_supabase"."approval_items" x where x."request_id" = v_req."id") then
    raise exception 'this request has no items; use decide_approval' using errcode = '22023', hint = 'APPROVAL_ITEMS_NONE';
  end if;
  if v_actor is not null and v_actor = v_req."requested_by" and coalesce(v_req."policy" ->> 'mode', 'authorize') <> 'confirm'
    and not coalesce((v_req."policy" ->> 'selfApproval')::boolean, false) then
    raise exception 'the requester can''t decide their own request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if v_actor is not null and coalesce(v_req."policy" -> 'excludedUserIds', '[]'::jsonb) ? v_actor::text then
    raise exception 'this user is left out of deciding this request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  for v_each in select e.value from jsonb_array_elements(decide_approval_items.decisions) e loop
    v_decision := v_each ->> 'decision';
    if v_decision is null or v_decision not in ('approved', 'rejected') or jsonb_typeof(v_each -> 'key') is distinct from 'string' then
      raise exception 'each decision needs a key and a decision of approved or rejected' using errcode = '22023', hint = 'APPROVAL_DECISION_INVALID';
    end if;
    select * into v_item from "better_supabase"."approval_items" x
    where x."request_id" = v_req."id" and x."key" = v_each ->> 'key' for update;
    if not found then
      raise exception 'this request has no such item' using errcode = 'P0002', hint = 'APPROVAL_ITEM_NOT_FOUND';
    end if;
    if v_item."status" <> 'pending' then
      raise exception 'this item is no longer pending' using errcode = '22023', hint = 'APPROVAL_ITEM_CLOSED';
    end if;
    if not v_service then
      if v_item."permission" is not null then
        if not (coalesce(better_supabase.can('tenant', v_req."tenant_id", v_item."permission"), false)) then
          raise exception 'not an approver for this item' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
        end if;
      elsif not "better_supabase"."approval_eligible"(v_req."id") then
        raise exception 'not an approver for this item' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
      end if;
    end if;
    if v_decision = 'approved' and exists (
      select 1 from "better_supabase"."approval_items" dep
      where dep."request_id" = v_req."id" and dep."key" = any(v_item."depends_on") and dep."status" <> 'approved'
    ) then
      raise exception 'an item this one depends on is not approved' using errcode = '22023', hint = 'APPROVAL_ITEM_BLOCKED';
    end if;
    declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_decision;
    end if;
  end;
    update "better_supabase"."approval_items" x set "status" = v_decision, "decided_by" = v_actor, "decided_at" = now()
    where x."id" = v_item."id";
    if v_decision = 'rejected' then
      with recursive blocked(key) as (
        select y."key" from "better_supabase"."approval_items" y
        where y."request_id" = v_req."id" and v_item."key" = any(y."depends_on")
        union
        select y."key" from "better_supabase"."approval_items" y join blocked b on b.key = any(y."depends_on")
        where y."request_id" = v_req."id"
      )
      update "better_supabase"."approval_items" x set "status" = 'rejected', "decided_by" = v_actor, "decided_at" = now()
      where x."request_id" = v_req."id" and x."status" = 'pending' and x."key" in (select key from blocked);
    end if;
  end loop;
  select count(*) filter (where x."status" = 'pending'), count(*) filter (where x."status" = 'approved')
    into v_pending, v_approved
  from "better_supabase"."approval_items" x where x."request_id" = v_req."id";
  if v_pending = 0 then
    v_outcome := case when v_approved > 0 then 'approved' else 'rejected' end;
    insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision")
    values (v_req."id", v_req."tenant_id", v_req."step", v_actor, v_outcome)
    on conflict do nothing;
    update "better_supabase"."approval_requests" r set "status" = v_outcome, "decided_at" = now()
      where r."id" = v_req."id" returning * into v_req;
    if v_outcome = 'approved' then
      perform "better_supabase"."approval_finalize"(v_req."id");
    else
      perform better_supabase.audit_event(
    event_type => 'approval.rejected',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'rejected' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
      perform "better_supabase"."approval_notify"(v_req."id", 'rejected');
    end if;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_req."status";
    end if;
  end;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at", 'fields', jsonb_build_object('token', v_req."token", 'body', v_req."body")) || jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = v_req."id"
    ), '[]'::jsonb));
end;
$$;
revoke execute on function "better_supabase"."decide_approval_items"(uuid, jsonb, uuid) from public, anon;
grant execute on function "better_supabase"."decide_approval_items"(uuid, jsonb, uuid) to authenticated, service_role;

-- Notes the record an approved item created, so a retry of the run that
-- creates it finds the record instead of creating another. The requester, a
-- manager or the service role records it, once per item.
create or replace function "better_supabase"."record_approval_created"(request_id uuid, item_key text, created_type text, created_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_item "better_supabase"."approval_items"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = record_approval_created.request_id;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_req."requested_by" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_req."tenant_id", 'approvals.manage'), false)) then
    raise exception 'only the requester or a manager records what an item created' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if nullif(btrim(record_approval_created.created_type), '') is null or nullif(btrim(record_approval_created.created_id), '') is null then
    raise exception 'created_type and created_id are required' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
  end if;
  select * into v_item from "better_supabase"."approval_items" x
  where x."request_id" = v_req."id" and x."key" = record_approval_created.item_key for update;
  if not found then
    raise exception 'this request has no such item' using errcode = 'P0002', hint = 'APPROVAL_ITEM_NOT_FOUND';
  end if;
  if v_item."status" <> 'approved' then
    raise exception 'only an approved item records what it created' using errcode = '22023', hint = 'APPROVAL_ITEM_CLOSED';
  end if;
  if v_item."created_type" is not null then
    raise exception 'this item already recorded what it created' using errcode = '23505', hint = 'APPROVAL_ITEM_RECORDED';
  end if;
  update "better_supabase"."approval_items" x set "created_type" = record_approval_created.created_type, "created_id" = record_approval_created.created_id
  where x."id" = v_item."id" returning * into v_item;
  return jsonb_build_object('id', v_item."id", 'key', v_item."key", 'label', v_item."label", 'payload', v_item."payload", 'permission', v_item."permission", 'dependsOn', to_jsonb(v_item."depends_on"), 'status', v_item."status", 'createdType', v_item."created_type", 'createdId', v_item."created_id", 'decidedBy', v_item."decided_by", 'decidedAt', v_item."decided_at", 'createdAt', v_item."created_at");
end;
$$;
revoke execute on function "better_supabase"."record_approval_created"(uuid, text, text, text) from public, anon;
grant execute on function "better_supabase"."record_approval_created"(uuid, text, text, text) to authenticated, service_role;

-- Closes a pending request on the system's behalf, such as a run that
-- finished or gave up. It writes a decision without an approver, settles the
-- items still pending to the outcome, and records the same events and runs the
-- same final approval as a person's decision, so waiters wake.
create or replace function "better_supabase"."settle_approval"(request_id uuid, outcome text, reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if settle_approval.outcome not in ('approved', 'rejected') then
    raise exception 'outcome must be approved or rejected' using errcode = '22023', hint = 'APPROVAL_DECISION_INVALID';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = settle_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", settle_approval.outcome;
    end if;
  end;
  update "better_supabase"."approval_items" x set "status" = settle_approval.outcome, "decided_at" = now()
  where x."request_id" = v_req."id" and x."status" = 'pending';
  insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision", "comment")
  values (v_req."id", v_req."tenant_id", v_req."step", null, settle_approval.outcome, left('system' || coalesce(': ' || settle_approval.reason, ''), 2000));
  update "better_supabase"."approval_requests" r set "status" = settle_approval.outcome, "decided_at" = now()
    where r."id" = v_req."id" returning * into v_req;
  if settle_approval.outcome = 'approved' then
    perform "better_supabase"."approval_finalize"(v_req."id");
  else
    perform better_supabase.audit_event(
    event_type => 'approval.rejected',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'rejected' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
    perform "better_supabase"."approval_notify"(v_req."id", 'rejected');
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_req."status";
    end if;
  end;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at", 'fields', jsonb_build_object('token', v_req."token", 'body', v_req."body")) || jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = v_req."id"
    ), '[]'::jsonb));
end;
$$;
revoke execute on function "better_supabase"."settle_approval"(uuid, text, text) from public, anon, authenticated;
grant execute on function "better_supabase"."settle_approval"(uuid, text, text) to service_role;

-- Hands the caller's place on the current step to another user.
create or replace function "better_supabase"."delegate_approval"(request_id uuid, to_user uuid, comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = delegate_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  if not "better_supabase"."approval_eligible"(v_req."id") then
    raise exception 'not an approver for this step' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if v_req."subject_type" in ('support_request') then
    raise exception 'the module that filed this request decides who approves it' using errcode = '22023', hint = 'APPROVAL_DELEGATE_INVALID';
  end if;
  if delegate_approval.to_user is null or delegate_approval.to_user = auth.uid() or delegate_approval.to_user = v_req."requested_by" then
    raise exception 'delegate to another user than yourself or the requester' using errcode = '22023', hint = 'APPROVAL_DELEGATE_INVALID';
  end if;
  if not v_req."tenant_id"::text in (
    select t.id::text from permdock.member_organization_ids_for(delegate_approval.to_user) as t(id)
  ) then
    raise exception 'the delegate is not a member of this organization' using errcode = '22023', hint = 'APPROVAL_DELEGATE_INVALID';
  end if;
  insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision", "delegate_to", "comment")
  values (v_req."id", v_req."tenant_id", v_req."step", auth.uid(), 'delegated', delegate_approval.to_user, delegate_approval.comment);
  perform better_supabase.audit_event(
    event_type => 'approval.delegated',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'delegated' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  perform "better_supabase"."approval_notify"(v_req."id", 'delegated');
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at", 'fields', jsonb_build_object('token', v_req."token", 'body', v_req."body"));
end;
$$;
revoke execute on function "better_supabase"."delegate_approval"(uuid, uuid, text) from public, anon;
grant execute on function "better_supabase"."delegate_approval"(uuid, uuid, text) to authenticated, service_role;

-- reason (up to 500 characters) goes into the audit entry, so a system that
-- cancels requests on the user's behalf, such as an agent session that ended,
-- says why.

create or replace function "better_supabase"."cancel_approval"(request_id uuid, reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = cancel_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_req."requested_by" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_req."tenant_id", 'approvals.manage'), false)) then
    raise exception 'only the requester or a manager can cancel this request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  update "better_supabase"."approval_requests" r set "status" = 'cancelled', "decided_at" = now()
    where r."id" = v_req."id" returning * into v_req;
  perform better_supabase.audit_event(
    event_type => 'approval.cancelled',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'cancelled' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id" || coalesce(': ' || left(nullif(btrim(cancel_approval.reason), ''), 500), ''),
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at", 'fields', jsonb_build_object('token', v_req."token", 'body', v_req."body"));
end;
$$;
revoke execute on function "better_supabase"."cancel_approval"(uuid, text) from public, anon;
grant execute on function "better_supabase"."cancel_approval"(uuid, text) to authenticated, service_role;

create or replace function "better_supabase"."get_approval"(request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = get_approval.request_id;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_req."requested_by" = auth.uid(), false) or "better_supabase"."approval_eligible"(v_req."id")
    or (coalesce(better_supabase.can('tenant', v_req."tenant_id", 'approvals.read'), false) and (not v_req."subject_type" in ('support_request') and (v_req."subject_type" = 'access_request' or true)))) then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at", 'fields', jsonb_build_object('token', v_req."token", 'body', v_req."body")) || jsonb_build_object(
    'canDecide', "better_supabase"."approval_eligible"(v_req."id"),
    'decisions', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'step', x."step", 'approver', x."approver", 'decision', x."decision", 'delegateTo', x."delegate_to", 'comment', x."comment", 'createdAt', x."created_at") order by x."created_at", x."id")
      from "better_supabase"."approval_decisions" x where x."request_id" = v_req."id"
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = v_req."id"
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function "better_supabase"."get_approval"(uuid) from public, anon;
grant execute on function "better_supabase"."get_approval"(uuid) to authenticated, service_role;

-- Many requests with their decisions and items in one read, in the order
-- requested. A request that is missing or that the caller cannot read is left
-- out instead of failing the batch.
create or replace function "better_supabase"."get_approvals"(request_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'subjectType', r."subject_type", 'subjectId', r."subject_id", 'action', r."action", 'status', r."status", 'step', r."step", 'steps', r."policy" -> 'steps', 'requestedBy', r."requested_by", 'reason', r."reason", 'payload', r."payload", 'expiresAt', r."expires_at", 'decidedAt', r."decided_at", 'mode', coalesce(r."policy" ->> 'mode', 'authorize'), 'fingerprint', r."fingerprint", 'consumedAt', r."consumed_at", 'createdAt', r."created_at", 'fields', jsonb_build_object('token', r."token", 'body', r."body")) || jsonb_build_object(
      'canDecide', "better_supabase"."approval_eligible"(r."id"),
      'decisions', coalesce((
        select jsonb_agg(jsonb_build_object('id', x."id", 'step', x."step", 'approver', x."approver", 'decision', x."decision", 'delegateTo', x."delegate_to", 'comment', x."comment", 'createdAt', x."created_at") order by x."created_at", x."id")
        from "better_supabase"."approval_decisions" x where x."request_id" = r."id"
      ), '[]'::jsonb),
      'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = r."id"
    ), '[]'::jsonb)
    ) order by array_position(get_approvals.request_ids, r."id")), '[]'::jsonb)
    from "better_supabase"."approval_requests" r
    where r."id" = any (get_approvals.request_ids)
      and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(r."requested_by" = auth.uid(), false) or "better_supabase"."approval_eligible"(r."id")
        or (coalesce(better_supabase.can('tenant', r."tenant_id", 'approvals.read'), false) and (not r."subject_type" in ('support_request') and (r."subject_type" = 'access_request' or true))))
  );
end;
$$;
revoke execute on function "better_supabase"."get_approvals"(uuid[]) from public, anon;
grant execute on function "better_supabase"."get_approvals"(uuid[]) to authenticated, service_role;

-- assigned: only requests whose current step the caller can decide.
create or replace function "better_supabase"."list_approvals"(tenant uuid, status text default 'pending', assigned boolean default false, subject_type text default null, subject_id text default null, page_size integer default 50, before timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
  v_read boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_approvals.tenant, 'approvals.read'), false);
begin
  select coalesce(jsonb_agg(t.j order by t.at desc, t.id), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at", 'fields', jsonb_build_object('token', x."token", 'body', x."body")) as j, x."created_at" as at, x."id" as id
    from "better_supabase"."approval_requests" x
    where x."tenant_id" = list_approvals.tenant
      and (list_approvals.status is null or x."status" = list_approvals.status)
      and (list_approvals.subject_type is null or x."subject_type" = list_approvals.subject_type)
      and (list_approvals.subject_id is null or x."subject_id" = list_approvals.subject_id)
      and (list_approvals.before is null or x."created_at" < list_approvals.before)
      and case
        when list_approvals.assigned then x."id" in (select "better_supabase"."approval_eligible_ids"(list_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(list_approvals.tenant))
      end
    order by x."created_at" desc, x."id"
    limit least(greatest(coalesce(list_approvals.page_size, 50), 1), 200)
  ) t;
  return v_rows;
end;
$$;
revoke execute on function "better_supabase"."list_approvals"(uuid, text, boolean, text, text, integer, timestamptz) from public, anon;
grant execute on function "better_supabase"."list_approvals"(uuid, text, boolean, text, text, integer, timestamptz) to authenticated, service_role;

-- The requests of an organization as a keyset page (ADR 0749, 0949), newest
-- first. filters is { status, subjectType, subjectId, action (each a value or
-- a list of them), assigned (only requests the caller can decide), sort,
-- direction, facet, count, limit, after, offset, paged, total, totalCap }. The
-- caller sees the same requests list_approvals shows.
create or replace function "better_supabase"."page_approvals"(tenant uuid, filters jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_approvals.filters, '{}'::jsonb);
  v_read boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_approvals.tenant, 'approvals.read'), false);
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
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'filters must be an object' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('status', 'subjectType') then
      raise exception 'facet is one of status, subjectType' using errcode = '22023', hint = 'APPROVAL_INVALID';
    end if;
    with s as (
      select (case v_facet when 'status' then (x."status")::text when 'subjectType' then (x."subject_type")::text end) as v
      from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
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
      select 1 from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('createdAt', 'action') then
    raise exception 'sort is one of createdAt, action' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at", 'fields', jsonb_build_object('token', x."token", 'body', x."body")) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."created_at" >= (v_after ->> 0)::timestamptz and ((x."created_at" > (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" < (v_after ->> 1)::uuid))))
      order by x."created_at" asc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at", 'fields', jsonb_build_object('token', x."token", 'body', x."body")) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."created_at", x."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" desc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at", 'fields', jsonb_build_object('token', x."token", 'body', x."body")) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."created_at" >= (v_after ->> 0)::timestamptz and ((x."created_at" > (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" < (v_after ->> 1)::uuid))))
      order by x."created_at" asc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at", 'fields', jsonb_build_object('token', x."token", 'body', x."body")) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."created_at", x."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" desc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'action' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at", 'fields', jsonb_build_object('token', x."token", 'body', x."body")) as j, jsonb_build_array((x."action")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."action" >= (v_after ->> 0)::text and ((x."action" > (v_after ->> 0)::text) or (x."action" = (v_after ->> 0)::text and x."id" < (v_after ->> 1)::uuid))))
      order by x."action" asc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'action' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at", 'fields', jsonb_build_object('token', x."token", 'body', x."body")) as j, jsonb_build_array((x."action")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."action", x."id") < ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."action" desc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$$;
revoke execute on function "better_supabase"."page_approvals"(uuid, jsonb) from public, anon;
grant execute on function "better_supabase"."page_approvals"(uuid, jsonb) to authenticated, service_role;

-- Whether the subject's latest request for the action was approved.
create or replace function "better_supabase"."is_approved"(subject_type text, subject_id text, action text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select x."status"::text in ('approved', 'consumed') from "better_supabase"."approval_requests" x
    where x."subject_type" = is_approved.subject_type and x."subject_id" = is_approved.subject_id and x."action" = is_approved.action
    order by x."created_at" desc limit 1
  ), false)
$$;
revoke execute on function "better_supabase"."is_approved"(text, text, text) from public, anon;
grant execute on function "better_supabase"."is_approved"(text, text, text) to authenticated, service_role;

-- Closes pending requests past expires_at. Run it from pg_cron:
--   select cron.schedule('expire-approvals', '*/15 * * * *', 'select "better_supabase"."expire_approvals"()');
create or replace function "better_supabase"."expire_approvals"(max_requests integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_count integer := 0;
begin
  for v_req in
    update "better_supabase"."approval_requests" r set "status" = 'expired', "decided_at" = now()
    where r."id" in (
      select x."id" from "better_supabase"."approval_requests" x
      where x."status" = 'pending' and x."expires_at" <= now()
      order by x."expires_at"
      limit greatest(coalesce(expire_approvals.max_requests, 500), 1)
      for update skip locked
    )
    returning r.*
  loop
    null;
    perform "better_supabase"."approval_notify"(v_req."id", 'expired');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke execute on function "better_supabase"."expire_approvals"(integer) from public, anon, authenticated;
grant execute on function "better_supabase"."expire_approvals"(integer) to service_role;

-- Reminds the approvers of requests pending longer than `after`, once per
-- `after`. Run it from pg_cron like expire_approvals.
create or replace function "better_supabase"."remind_approvals"(after interval default interval '1 day', max_requests integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    update "better_supabase"."approval_requests" r set "reminded_at" = now()
    where r."id" in (
      select x."id" from "better_supabase"."approval_requests" x
      where x."status" = 'pending'
        and (x."expires_at" is null or x."expires_at" > now())
        and x."created_at" <= now() - remind_approvals.after
        and (x."reminded_at" is null or x."reminded_at" <= now() - remind_approvals.after)
      order by x."created_at"
      limit greatest(coalesce(remind_approvals.max_requests, 200), 1)
      for update skip locked
    )
    returning r."id"
  loop
    perform "better_supabase"."approval_notify"(v_id, 'reminder');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke execute on function "better_supabase"."remind_approvals"(interval, integer) from public, anon, authenticated;
grant execute on function "better_supabase"."remind_approvals"(interval, integer) to service_role;

-- Lets the fallback approvers (escalateTo) of a step decide it too once the
-- step has waited its escalateAfter, and asks them. Run it from pg_cron like
-- remind_approvals.
create or replace function "better_supabase"."escalate_approvals"(max_requests integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_count integer := 0;
begin
  for v_req in
    select * from "better_supabase"."approval_requests" r
    where r."status" = 'pending'
      and (r."expires_at" is null or r."expires_at" > now())
      and r."policy" -> 'steps' -> r."step" ? 'escalateAfter'
      and not coalesce((r."policy" -> 'steps' -> r."step" ->> 'escalated')::boolean, false)
      and coalesce((
        select max(x."created_at") from "better_supabase"."approval_decisions" x
        where x."request_id" = r."id" and x."step" = r."step" - 1
      ), r."created_at") + (r."policy" -> 'steps' -> r."step" ->> 'escalateAfter')::interval <= now()
    order by r."created_at"
    limit greatest(coalesce(escalate_approvals.max_requests, 200), 1)
    for update skip locked
  loop
    update "better_supabase"."approval_requests" r set "policy" = jsonb_set(r."policy", array['steps', (r."step")::text, 'escalated'], 'true'::jsonb)
    where r."id" = v_req."id"
    returning * into v_req;
    perform better_supabase.audit_event(
    event_type => 'approval.escalated',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'escalated' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
    perform "better_supabase"."approval_notify"(v_req."id", 'escalated');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke execute on function "better_supabase"."escalate_approvals"(integer) from public, anon, authenticated;
grant execute on function "better_supabase"."escalate_approvals"(integer) to service_role;

-- Tenant isolation (ADR 0099): permissive policies combine with or, so one
-- the app adds would widen the block's. These restrictive policies keep each
-- table to the caller's organizations and what the block's policies grant.
create policy bsb_tenant_scope_select on "better_supabase"."approval_requests" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or (("tenant_id" in (select better_supabase.tenant_ids_with('approvals.read')) and not "subject_type" in ('support_request')) or "requested_by" = (select auth.uid()))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."approval_requests" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."approval_requests" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."approval_requests" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_select on "better_supabase"."approval_decisions" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('approvals.read')))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."approval_decisions" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."approval_decisions" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."approval_decisions" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_select on "better_supabase"."approval_items" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('approvals.read')))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."approval_items" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."approval_items" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."approval_items" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));

-- Row audit for the module's tables (blocks.audit.options.blockTables)
create constraint trigger bsb_audit after insert or update or delete on better_supabase.approval_requests deferrable initially deferred for each row when (better_supabase.import_run() is null or current_setting('better_supabase.import_audit', true) is distinct from 'summary') execute function better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"approval","event_prefix":"approval"}');
