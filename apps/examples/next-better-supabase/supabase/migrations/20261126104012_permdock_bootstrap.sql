SET local check_function_bodies = off;

DROP FUNCTION "better_supabase"."request_approval"(uuid, text, text, text, text, jsonb, text, jsonb, uuid);

CREATE TABLE "better_supabase"."platform_invitations" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "email"       text                     NOT NULL,
  "role"        text                     NOT NULL,
  "token_hash"  text                     NOT NULL,
  "expires_at"  timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "invited_by"  uuid,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "accepted_by" uuid,
  "declined_at" timestamp with time zone,
  "revoked_at"  timestamp with time zone,
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "platform_invitations_pkey" PRIMARY KEY (id),
  CONSTRAINT "platform_invitations_token_hash_key" UNIQUE (token_hash)
);

ALTER TABLE "better_supabase"."platform_invitations"
  ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION better_supabase.accept_invitation (
  token text
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
  invite "better_supabase"."invitations";
  pinvite "better_supabase"."platform_invitations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if me is null then
    raise exception 'Sign in to accept an invitation' using errcode = '42501', hint = 'INVITATION_SIGN_IN';
  end if;
  select * into invite
  from "better_supabase"."invitations" i
  where i."token_hash" = encode(extensions.digest(token, 'sha256'), 'hex')
  for update;
  if invite."id" is null then
  select * into pinvite
  from "better_supabase"."platform_invitations" i
  where i."token_hash" = encode(extensions.digest(token, 'sha256'), 'hex')
  for update;
  if pinvite."id" is not null then
  if not (pinvite."accepted_at" is null and pinvite."declined_at" is null and pinvite."revoked_at" is null) then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if pinvite."expires_at" < now() then
    raise exception 'The invitation has expired; ask for a new one' using errcode = 'P0002', hint = 'INVITATION_EXPIRED';
  end if;
  if lower(pinvite."email") <> lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'The invitation is for another email address' using errcode = '42501', hint = 'INVITATION_EMAIL_MISMATCH';
  end if;
  -- The email claim alone does not prove the address: an unconfirmed sign-up carries it too.
  if not exists (
    select 1 from auth.users u
    where u.id = me and u.email_confirmed_at is not null and lower(u.email) = lower(pinvite."email")
  ) then
    raise exception 'Confirm your email address before accepting the invitation' using errcode = '42501', hint = 'INVITATION_EMAIL_UNCONFIRMED';
  end if;
  if pinvite."invited_by" = me then
    raise exception 'You cannot accept your own invitation' using errcode = '42501', hint = 'INVITATION_SELF';
  end if;
  if pinvite."invited_by" is not null and not (
    coalesce(better_supabase.platform_can(pinvite."invited_by", 'platform.invite'), false)
  ) then
    raise exception 'The person who invited you can no longer assign that role' using errcode = '42501', hint = 'INVITATION_INVITER_REVOKED';
  end if;
  if pinvite."role" is null then
    raise exception 'Unknown platform role %', pinvite."role" using errcode = '23514', hint = 'INVITATION_ROLE_UNKNOWN';
  end if;
  perform set_config('better_supabase.accepting_invitation', pinvite."id"::text, true);
  insert into "permdock"."user_roles" ("user_id", "role")
  values (me, pinvite."role")
  on conflict do nothing;
  perform set_config('better_supabase.accepting_invitation', '', true);
  update "better_supabase"."platform_invitations"
  set "accepted_at" = now(), "accepted_by" = me
  where "id" = pinvite."id";
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_invitation_accept"(uuid, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid)', v_hook::oid::regproc)
        using pinvite."id", me;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'invitation.accepted',
    category => 'membership',
    target_type => 'invitation',
    record_id => pinvite."id"::text,
    metadata => jsonb_build_object('invitationId', pinvite."id", 'organizationId', null, 'email', pinvite."email", 'role', pinvite."role")
  );
  return null;
  end if;
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if not (invite."accepted_at" is null and invite."declined_at" is null and invite."revoked_at" is null) then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if invite."expires_at" < now() then
    raise exception 'The invitation has expired; ask for a new one' using errcode = 'P0002', hint = 'INVITATION_EXPIRED';
  end if;
  if lower(invite."email") <> lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'The invitation is for another email address' using errcode = '42501', hint = 'INVITATION_EMAIL_MISMATCH';
  end if;
  -- The email claim alone does not prove the address: an unconfirmed sign-up carries it too.
  if not exists (
    select 1 from auth.users u
    where u.id = me and u.email_confirmed_at is not null and lower(u.email) = lower(invite."email")
  ) then
    raise exception 'Confirm your email address before accepting the invitation' using errcode = '42501', hint = 'INVITATION_EMAIL_UNCONFIRMED';
  end if;
  if invite."invited_by" = me then
    raise exception 'You cannot accept your own invitation' using errcode = '42501', hint = 'INVITATION_SELF';
  end if;
  if better_supabase.tenant_disabled(invite."tenant_id") or not exists (select 1 from "better_supabase"."organizations" o where o."id" = invite."tenant_id") then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if exists (select 1 from "public"."organization_memberships" m where m."organization_id" = invite."tenant_id" and m."user_id" = me) then
    raise exception 'You are already a member' using errcode = '23505', hint = 'INVITATION_ALREADY_MEMBER';
  end if;
    if invite."invited_by" is not null
      and better_supabase.can_user(invite."invited_by", 'organization', invite."tenant_id", 'members.invite') is false then
      raise exception 'The person who invited you can no longer invite members' using errcode = '42501', hint = 'INVITATION_INVITER_REVOKED';
    end if;
  perform set_config('better_supabase.accepting_invitation', invite."id"::text, true);
  insert into "public"."organization_memberships" ("organization_id", "user_id", "role")
  values (invite."tenant_id", me, invite."role");
  perform set_config('better_supabase.accepting_invitation', '', true);
  update "better_supabase"."invitations"
  set "accepted_at" = now(), "accepted_by" = me
  where "id" = invite."id";
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_invitation_accept"(uuid, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid)', v_hook::oid::regproc)
        using invite."id", me;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'invitation.accepted',
    category => 'membership',
    target_type => 'invitation',
    record_id => invite."id"::text,
    tenant => (invite."tenant_id")::uuid,
    metadata => jsonb_build_object('invitationId', invite."id", 'organizationId', invite."tenant_id"::text, 'email', invite."email", 'role', invite."role")
  );
  perform better_supabase.audit_event(
    event_type => 'organization.member_added',
    category => 'membership',
    target_type => 'user',
    record_id => me::text,
    tenant => (invite."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', invite."tenant_id"::text, 'userId', me, 'role', invite."role")
  );
  return invite."tenant_id";
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.accept_invitation_by_id (
  invitation_id uuid
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
  invite "better_supabase"."invitations";
  pinvite "better_supabase"."platform_invitations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if me is null then
    raise exception 'Sign in to accept an invitation' using errcode = '42501', hint = 'INVITATION_SIGN_IN';
  end if;
  select * into invite
  from "better_supabase"."invitations" i
  where i."id" = invitation_id
  for update;
  if invite."id" is null then
  select * into pinvite
  from "better_supabase"."platform_invitations" i
  where i."id" = invitation_id
  for update;
  if pinvite."id" is not null then
  if not (pinvite."accepted_at" is null and pinvite."declined_at" is null and pinvite."revoked_at" is null) then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if pinvite."expires_at" < now() then
    raise exception 'The invitation has expired; ask for a new one' using errcode = 'P0002', hint = 'INVITATION_EXPIRED';
  end if;
  if lower(pinvite."email") <> lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'The invitation is for another email address' using errcode = '42501', hint = 'INVITATION_EMAIL_MISMATCH';
  end if;
  -- The email claim alone does not prove the address: an unconfirmed sign-up carries it too.
  if not exists (
    select 1 from auth.users u
    where u.id = me and u.email_confirmed_at is not null and lower(u.email) = lower(pinvite."email")
  ) then
    raise exception 'Confirm your email address before accepting the invitation' using errcode = '42501', hint = 'INVITATION_EMAIL_UNCONFIRMED';
  end if;
  if pinvite."invited_by" = me then
    raise exception 'You cannot accept your own invitation' using errcode = '42501', hint = 'INVITATION_SELF';
  end if;
  if pinvite."invited_by" is not null and not (
    coalesce(better_supabase.platform_can(pinvite."invited_by", 'platform.invite'), false)
  ) then
    raise exception 'The person who invited you can no longer assign that role' using errcode = '42501', hint = 'INVITATION_INVITER_REVOKED';
  end if;
  if pinvite."role" is null then
    raise exception 'Unknown platform role %', pinvite."role" using errcode = '23514', hint = 'INVITATION_ROLE_UNKNOWN';
  end if;
  perform set_config('better_supabase.accepting_invitation', pinvite."id"::text, true);
  insert into "permdock"."user_roles" ("user_id", "role")
  values (me, pinvite."role")
  on conflict do nothing;
  perform set_config('better_supabase.accepting_invitation', '', true);
  update "better_supabase"."platform_invitations"
  set "accepted_at" = now(), "accepted_by" = me
  where "id" = pinvite."id";
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_invitation_accept"(uuid, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid)', v_hook::oid::regproc)
        using pinvite."id", me;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'invitation.accepted',
    category => 'membership',
    target_type => 'invitation',
    record_id => pinvite."id"::text,
    metadata => jsonb_build_object('invitationId', pinvite."id", 'organizationId', null, 'email', pinvite."email", 'role', pinvite."role")
  );
  return null;
  end if;
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if not (invite."accepted_at" is null and invite."declined_at" is null and invite."revoked_at" is null) then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if invite."expires_at" < now() then
    raise exception 'The invitation has expired; ask for a new one' using errcode = 'P0002', hint = 'INVITATION_EXPIRED';
  end if;
  if lower(invite."email") <> lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'The invitation is for another email address' using errcode = '42501', hint = 'INVITATION_EMAIL_MISMATCH';
  end if;
  -- The email claim alone does not prove the address: an unconfirmed sign-up carries it too.
  if not exists (
    select 1 from auth.users u
    where u.id = me and u.email_confirmed_at is not null and lower(u.email) = lower(invite."email")
  ) then
    raise exception 'Confirm your email address before accepting the invitation' using errcode = '42501', hint = 'INVITATION_EMAIL_UNCONFIRMED';
  end if;
  if invite."invited_by" = me then
    raise exception 'You cannot accept your own invitation' using errcode = '42501', hint = 'INVITATION_SELF';
  end if;
  if better_supabase.tenant_disabled(invite."tenant_id") or not exists (select 1 from "better_supabase"."organizations" o where o."id" = invite."tenant_id") then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if exists (select 1 from "public"."organization_memberships" m where m."organization_id" = invite."tenant_id" and m."user_id" = me) then
    raise exception 'You are already a member' using errcode = '23505', hint = 'INVITATION_ALREADY_MEMBER';
  end if;
    if invite."invited_by" is not null
      and better_supabase.can_user(invite."invited_by", 'organization', invite."tenant_id", 'members.invite') is false then
      raise exception 'The person who invited you can no longer invite members' using errcode = '42501', hint = 'INVITATION_INVITER_REVOKED';
    end if;
  perform set_config('better_supabase.accepting_invitation', invite."id"::text, true);
  insert into "public"."organization_memberships" ("organization_id", "user_id", "role")
  values (invite."tenant_id", me, invite."role");
  perform set_config('better_supabase.accepting_invitation', '', true);
  update "better_supabase"."invitations"
  set "accepted_at" = now(), "accepted_by" = me
  where "id" = invite."id";
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_invitation_accept"(uuid, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid)', v_hook::oid::regproc)
        using invite."id", me;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'invitation.accepted',
    category => 'membership',
    target_type => 'invitation',
    record_id => invite."id"::text,
    tenant => (invite."tenant_id")::uuid,
    metadata => jsonb_build_object('invitationId', invite."id", 'organizationId', invite."tenant_id"::text, 'email', invite."email", 'role', invite."role")
  );
  perform better_supabase.audit_event(
    event_type => 'organization.member_added',
    category => 'membership',
    target_type => 'user',
    record_id => me::text,
    tenant => (invite."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', invite."tenant_id"::text, 'userId', me, 'role', invite."role")
  );
  return invite."tenant_id";
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.bootstrap_app (
  args jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if not (select better_supabase.session_active()) then
    return jsonb_build_object(
      'session_active', false,
      'end_reason', better_supabase.session_end_reason(),
      'authz_version', auth.jwt() -> 'authz_ver',
      'token_authz_version', auth.jwt() -> 'authz_ver',
      'tenant', args ->> 'tenant',
      'data', null
    );
  end if;
  return jsonb_build_object(
    'session_active', true,
    'authz_version', to_jsonb(better_supabase.caller_authz_version()),
    'token_authz_version', auth.jwt() -> 'authz_ver',
    'tenant', args ->> 'tenant',
    'data', to_jsonb(public.sample_authz_version(args)),
    'subject', case when nullif(args ->> 'tenant', '') is null then to_jsonb(permdock.permdock_subject()) else to_jsonb(permdock.permdock_subject(((args ->> 'tenant'))::text)) end,
    'subject_tenant', nullif(args ->> 'tenant', '')
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.cancel_approval (
  request_id uuid,
  reason     text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.consume_approval (
  request_id  uuid,
  fingerprint text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.decide_approval (
  request_id uuid,
  decision   text,
  comment    text DEFAULT NULL::text,
  decided_by uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.decide_approval_items (
  request_id uuid,
  decisions  jsonb,
  decided_by uuid  DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.decline_invitation (
  token text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  declined_id uuid;
  tenant text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  update "better_supabase"."invitations" i set "declined_at" = now() where i."token_hash" = encode(extensions.digest(token, 'sha256'), 'hex') and i."expires_at" >= now() and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  returning i."id", i."tenant_id"::text into declined_id, tenant;
  if declined_id is not null then
    perform better_supabase.audit_event(
    event_type => 'invitation.declined',
    category => 'membership',
    target_type => 'invitation',
    record_id => declined_id::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', declined_id, 'organizationId', tenant)
  );
    return true;
  end if;
  update "better_supabase"."platform_invitations" i set "declined_at" = now() where i."token_hash" = encode(extensions.digest(token, 'sha256'), 'hex') and i."expires_at" >= now() and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  returning i."id" into declined_id;
  if declined_id is not null then
    perform better_supabase.audit_event(
    event_type => 'invitation.declined',
    category => 'membership',
    target_type => 'invitation',
    record_id => declined_id::text,
    metadata => jsonb_build_object('invitationId', declined_id, 'organizationId', null)
  );
    return true;
  end if;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.decline_invitation_by_id (
  invitation_id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  declined_id uuid;
  tenant text;
  invitee_email text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select lower(u.email) into invitee_email
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;
  if invitee_email is null then
    return false;
  end if;
  update "better_supabase"."invitations" i set "declined_at" = now() where i."id" = invitation_id and lower(i."email") = invitee_email and i."expires_at" >= now() and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  returning i."id", i."tenant_id"::text into declined_id, tenant;
  if declined_id is not null then
    perform better_supabase.audit_event(
    event_type => 'invitation.declined',
    category => 'membership',
    target_type => 'invitation',
    record_id => declined_id::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', declined_id, 'organizationId', tenant)
  );
    return true;
  end if;
  update "better_supabase"."platform_invitations" i set "declined_at" = now() where i."id" = invitation_id and lower(i."email") = invitee_email and i."expires_at" >= now() and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  returning i."id" into declined_id;
  if declined_id is not null then
    perform better_supabase.audit_event(
    event_type => 'invitation.declined',
    category => 'membership',
    target_type => 'invitation',
    record_id => declined_id::text,
    metadata => jsonb_build_object('invitationId', declined_id, 'organizationId', null)
  );
    return true;
  end if;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.delegate_approval (
  request_id uuid,
  to_user    uuid,
  comment    text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_approval (
  request_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_approvals (
  request_ids uuid[]
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.invitation_preview (
  token text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  preview jsonb;
  invitation uuid;
begin
  select jsonb_build_object(
    'status', case
    when i."accepted_at" is not null then 'accepted'
    when i."declined_at" is not null then 'declined'
    when i."revoked_at" is not null then 'revoked'
    when i."expires_at" < now() then 'expired'
    else 'pending'
  end,
    'email', i."email",
    'role', i."role",
    'tenant', i."tenant_id",
    'expires_at', i."expires_at",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = i."tenant_id"),
    'prefill', '{}'::jsonb
  ), i."id"
  into preview, invitation
  from "better_supabase"."invitations" i
  where i."token_hash" = encode(extensions.digest(invitation_preview.token, 'sha256'), 'hex');
  if preview is null then
    select jsonb_build_object(
    'status', case
    when i."accepted_at" is not null then 'accepted'
    when i."declined_at" is not null then 'declined'
    when i."revoked_at" is not null then 'revoked'
    when i."expires_at" < now() then 'expired'
    else 'pending'
  end,
    'email', i."email",
    'role', i."role",
    'tenant', null,
    'expires_at', i."expires_at",
    'organization', null,
    'prefill', '{}'::jsonb
  ), i."id"
    into preview, invitation
    from "better_supabase"."platform_invitations" i
    where i."token_hash" = encode(extensions.digest(invitation_preview.token, 'sha256'), 'hex');
  end if;
  if preview is not null then
    preview := preview || "better_supabase"."invitation_extra"(invitation);
  end if;
  return preview;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.invite_member (
  tenant        uuid,
  invitee_email text,
  invitee_role  text,
  valid_for     interval DEFAULT '7 days'::interval,
  prefill       jsonb    DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  token text := encode(extensions.gen_random_bytes(24), 'hex');
  created "better_supabase"."invitations";
  platform_created "better_supabase"."platform_invitations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if valid_for is null or valid_for <= interval '0' or valid_for > '30 days'::interval then
    raise exception 'An invitation is valid for at most %', '30 days' using errcode = '22023', hint = 'INVITATION_VALIDITY';
  end if;
  if tenant is null then
    if not service and not (select coalesce(better_supabase.is_platform('platform.invite'), false)) then
      raise exception 'Not allowed to invite platform users' using errcode = '42501', hint = 'INVITATION_FORBIDDEN';
    end if;
    if invitee_role is null then
      raise exception 'Unknown platform role %', invitee_role using errcode = '23514', hint = 'INVITATION_ROLE_UNKNOWN';
    end if;
    -- No platform role ceiling: holding the invite permission is enough.
    declare
    v_hook regprocedure := to_regprocedure('"public"."before_invitation_create"(uuid, text, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text, $3::text)', v_hook::oid::regproc)
        using tenant, invitee_email, invitee_role;
    end if;
  end;
    delete from "better_supabase"."platform_invitations" i
    where lower(i."email") = lower(btrim(invitee_email)) and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null;
    insert into "better_supabase"."platform_invitations" ("email", "role", "token_hash", "invited_by", "expires_at")
    values (lower(btrim(invitee_email)), invitee_role, encode(extensions.digest(token, 'sha256'), 'hex'), auth.uid(), now() + valid_for)
    returning * into platform_created;
    perform better_supabase.audit_event(
    event_type => 'invitation.created',
    category => 'membership',
    target_type => 'invitation',
    record_id => platform_created."id"::text,
    metadata => jsonb_build_object('invitationId', platform_created."id", 'organizationId', null, 'email', platform_created."email", 'role', platform_created."role")
  );
    return (jsonb_build_object(
    'id', platform_created."id",
    'tenant', null,
    'email', platform_created."email",
    'role', platform_created."role",
    'expires_at', platform_created."expires_at",
    'created_at', platform_created."created_at",
    'invited_by', platform_created."invited_by",
    'organization', null,
    'prefill', '{}'::jsonb,
    'token', token
  ) || "better_supabase"."invitation_extra"(platform_created."id"));
  end if;
  invitee_role := coalesce(invitee_role, 'member');
  if not service and not coalesce(better_supabase.member_can(auth.uid(), tenant, 'members.invite'), false) then
    raise exception 'Not allowed to invite members' using errcode = '42501', hint = 'INVITATION_FORBIDDEN';
  end if;
  if better_supabase.tenant_disabled(tenant) or not exists (select 1 from "better_supabase"."organizations" o where o."id" = tenant) then
    raise exception 'The organization is not active' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if false then
    raise exception 'Unknown role %', invitee_role using errcode = '23514', hint = 'INVITATION_ROLE_UNKNOWN';
  end if;
  if not service and not better_supabase.can_assign(tenant, (invitee_role)::text) then
    raise exception 'That role is above your own' using errcode = '42501', hint = 'INVITATION_ROLE_FORBIDDEN';
  end if;
  if exists (
    select 1 from "public"."organization_memberships" m join auth.users u on u.id = m."user_id"
    where m."organization_id" = tenant and lower(u.email) = lower(btrim(invitee_email))
  ) then
    raise exception '% is already a member', invitee_email using errcode = '23505', hint = 'INVITATION_ALREADY_MEMBER';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_invitation_create"(uuid, text, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text, $3::text)', v_hook::oid::regproc)
        using tenant, invitee_email, invitee_role;
    end if;
  end;
  delete from "better_supabase"."invitations" i
  where i."tenant_id" = tenant
    and lower(i."email") = lower(btrim(invitee_email))
    and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null;
  insert into "better_supabase"."invitations" ("tenant_id", "email", "role", "token_hash", "invited_by", "expires_at")
  values (tenant, lower(btrim(invitee_email)), invitee_role, encode(extensions.digest(token, 'sha256'), 'hex'), auth.uid(), now() + valid_for)
  returning * into created;
  perform better_supabase.audit_event(
    event_type => 'invitation.created',
    category => 'membership',
    target_type => 'invitation',
    record_id => created."id"::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', created."id", 'organizationId', tenant::text, 'email', created."email", 'role', created."role")
  );
  return (jsonb_build_object(
    'id', created."id",
    'tenant', created."tenant_id",
    'email', created."email",
    'role', created."role",
    'expires_at', created."expires_at",
    'created_at', created."created_at",
    'invited_by', created."invited_by",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = created."tenant_id"),
    'prefill', '{}'::jsonb,
    'token', token
  ) || "better_supabase"."invitation_extra"(created."id"));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_approvals (
  tenant       uuid,
  status       text                     DEFAULT 'pending'::text,
  assigned     boolean                  DEFAULT false,
  subject_type text                     DEFAULT NULL::text,
  subject_id   text                     DEFAULT NULL::text,
  page_size    integer                  DEFAULT 50,
  before       timestamp with time zone DEFAULT NULL::timestamp WITH time zone
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
    then coalesce(array(select k from unnest(coalesce((array(select permdock.permitted_organization_permission_keys_for(member, tenant))), '{}'::text[])) as k where k = any(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.create', 'quotes.read', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[])), '{}'::text[])
    else '{}'::text[]
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.my_invitations()
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  invitee_email text;
  result jsonb := '[]'::jsonb;
begin
  select lower(u.email) into invitee_email
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;
  if invitee_email is null then
    return result;
  end if;
  select coalesce(jsonb_agg(x.invitation order by x.expires_at), '[]'::jsonb)
  into result
  from (
    select (jsonb_build_object(
    'id', i."id",
    'tenant', i."tenant_id",
    'email', i."email",
    'role', i."role",
    'expires_at', i."expires_at",
    'created_at', i."created_at",
    'invited_by', i."invited_by",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = i."tenant_id"),
    'prefill', '{}'::jsonb,
    'token', null
  ) || "better_supabase"."invitation_extra"(i."id")) - 'token' as invitation, i."id" as id, i."expires_at" as expires_at
    from "better_supabase"."invitations" i
    where lower(i."email") = invitee_email
      and i."expires_at" >= now() and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
    union all
    select (jsonb_build_object(
    'id', i."id",
    'tenant', null,
    'email', i."email",
    'role', i."role",
    'expires_at', i."expires_at",
    'created_at', i."created_at",
    'invited_by', i."invited_by",
    'organization', null,
    'prefill', '{}'::jsonb,
    'token', null
  ) || "better_supabase"."invitation_extra"(i."id")) - 'token' as invitation, i."id" as id, i."expires_at" as expires_at
    from "better_supabase"."platform_invitations" i
    where lower(i."email") = invitee_email
      and i."expires_at" >= now() and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  ) x;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.open_approval (
  tenant       uuid,
  subject_type text,
  subject_id   text,
  action       text,
  policy       jsonb,
  reason       text,
  payload      jsonb,
  requested_by uuid    DEFAULT NULL::uuid,
  on_behalf    boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.page_approvals (
  tenant  uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.platform_invitations_readable()
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  return (select coalesce(better_supabase.is_platform('platform.invite'), false));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.request_approval (
  tenant       uuid,
  subject_type text,
  subject_id   text,
  action       text,
  reason       text  DEFAULT NULL::text,
  payload      jsonb DEFAULT '{}'::jsonb,
  fields       jsonb DEFAULT NULL::jsonb,
  fingerprint  text  DEFAULT NULL::text,
  policy       jsonb DEFAULT NULL::jsonb,
  requested_by uuid  DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.resend_invitation (
  invitation_id uuid,
  valid_for     interval DEFAULT '7 days'::interval
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  token text := encode(extensions.gen_random_bytes(24), 'hex');
  updated "better_supabase"."invitations";
  platform_updated "better_supabase"."platform_invitations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if valid_for is null or valid_for <= interval '0' or valid_for > '30 days'::interval then
    raise exception 'An invitation is valid for at most %', '30 days' using errcode = '22023', hint = 'INVITATION_VALIDITY';
  end if;
  update "better_supabase"."invitations" i
  set "token_hash" = encode(extensions.digest(token, 'sha256'), 'hex'),
    "expires_at" = now() + valid_for
  where i."id" = invitation_id and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
    and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), i."tenant_id", 'members.invite'), false))
  returning * into updated;
  if updated."id" is null then
    update "better_supabase"."platform_invitations" i
    set "token_hash" = encode(extensions.digest(token, 'sha256'), 'hex'),
      "expires_at" = now() + valid_for
    where i."id" = invitation_id and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
      and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (select coalesce(better_supabase.is_platform('platform.invite'), false)))
    returning * into platform_updated;
    if platform_updated."id" is not null then
      perform better_supabase.audit_event(
    event_type => 'invitation.resent',
    category => 'membership',
    target_type => 'invitation',
    record_id => platform_updated."id"::text,
    metadata => jsonb_build_object('invitationId', platform_updated."id", 'organizationId', null, 'email', platform_updated."email")
  );
      return (jsonb_build_object(
    'id', platform_updated."id",
    'tenant', null,
    'email', platform_updated."email",
    'role', platform_updated."role",
    'expires_at', platform_updated."expires_at",
    'created_at', platform_updated."created_at",
    'invited_by', platform_updated."invited_by",
    'organization', null,
    'prefill', '{}'::jsonb,
    'token', token
  ) || "better_supabase"."invitation_extra"(platform_updated."id"));
    end if;
    raise exception 'No open invitation %', invitation_id using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  perform better_supabase.audit_event(
    event_type => 'invitation.resent',
    category => 'membership',
    target_type => 'invitation',
    record_id => updated."id"::text,
    tenant => (updated."tenant_id")::uuid,
    metadata => jsonb_build_object('invitationId', updated."id", 'organizationId', updated."tenant_id"::text, 'email', updated."email")
  );
  return (jsonb_build_object(
    'id', updated."id",
    'tenant', updated."tenant_id",
    'email', updated."email",
    'role', updated."role",
    'expires_at', updated."expires_at",
    'created_at', updated."created_at",
    'invited_by', updated."invited_by",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = updated."tenant_id"),
    'prefill', '{}'::jsonb,
    'token', token
  ) || "better_supabase"."invitation_extra"(updated."id"));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.revoke_invitation (
  invitation_id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  tenant text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  update "better_supabase"."invitations" i set "revoked_at" = now() where i."id" = invitation_id and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), i."tenant_id", 'members.invite'), false)) and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  returning i."tenant_id"::text into tenant;
  if found then
    perform better_supabase.audit_event(
    event_type => 'invitation.revoked',
    category => 'membership',
    target_type => 'invitation',
    record_id => invitation_id::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', invitation_id, 'organizationId', tenant)
  );
    return true;
  end if;
  update "better_supabase"."platform_invitations" i set "revoked_at" = now() where i."id" = invitation_id and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (select coalesce(better_supabase.is_platform('platform.invite'), false))) and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null;
  if found then
    perform better_supabase.audit_event(
    event_type => 'invitation.revoked',
    category => 'membership',
    target_type => 'invitation',
    record_id => invitation_id::text,
    metadata => jsonb_build_object('invitationId', invitation_id, 'organizationId', null)
  );
    return true;
  end if;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.settle_approval (
  request_id uuid,
  outcome    text,
  reason     text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION better_supabase.start_support_session (
  target    uuid,
  reason    text     DEFAULT NULL::text,
  ttl       interval DEFAULT '00:30:00'::interval,
  read_only boolean  DEFAULT true,
  metadata  jsonb    DEFAULT '{}'::jsonb,
  tenant    uuid     DEFAULT NULL::uuid,
  admin_id  uuid     DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  admin uuid;
  session_id uuid;
  started jsonb;
  approval_id uuid;
  approver uuid;
begin
  if service then
    admin := admin_id;
    if admin is null then
      raise exception 'admin_id is required for the service role' using errcode = '22023', hint = 'IMPERSONATION_FORBIDDEN';
    end if;
  else
    admin := auth.uid();
    if admin is null or (admin_id is not null and admin_id <> admin)
      or not "better_supabase"."is_platform"('impersonation.start') then
      raise exception 'Not allowed to start a support session' using errcode = '42501', hint = 'IMPERSONATION_FORBIDDEN';
    end if;
  end if;
  if target = admin then
    raise exception 'An admin cannot start a support session as themselves' using errcode = '22023', hint = 'IMPERSONATION_SELF';
  end if;
  if not exists (select 1 from auth.users u where u.id = target) then
    raise exception 'No user %', target using errcode = 'P0002', hint = 'IMPERSONATION_TARGET_MISSING';
  end if;
  if ttl <= interval '0' or ttl > '4 hours'::interval then
    raise exception 'ttl must be between 0 and %', '4 hours' using errcode = '22023', hint = 'IMPERSONATION_TTL';
  end if;
  -- Viewing the app as platform staff would hand the admin that staff's reach.
  if (exists (
    select 1 from auth.users u
    where u.id = target and jsonb_typeof(u.raw_app_meta_data -> 'platform_permissions') = 'array'
      and jsonb_array_length(u.raw_app_meta_data -> 'platform_permissions') > 0
  ) or exists (
    select 1 from "permdock"."user_roles" a where a."user_id" = target
  )) then
    raise exception 'A support session cannot target platform staff' using errcode = '42501', hint = 'IMPERSONATION_TARGET_PLATFORM';
  end if;
  if not coalesce(read_only, true) then
    raise exception 'Support sessions are read-only (blocks.impersonation.options.allowWrites)' using errcode = '42501', hint = 'IMPERSONATION_WRITES_DISABLED';
  end if;
  if coalesce(btrim(reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023', hint = 'IMPERSONATION_REASON_REQUIRED';
  end if;
  -- A second admin approved this start: the approval is consumed below.
  select x."id", x."approved_by" into approval_id, approver
  from "better_supabase"."support_requests" x
  where x."admin_id" = admin
    and x."target_id" = target
    and x."tenant_id" is not distinct from tenant
    and (not x."read_only" or coalesce(read_only, true))
    and x."approved_by" is not null
    and x."approved_by" <> admin
    and x."session_id" is null
    and x."expires_at" > now()
  order by x."approved_at" desc
  limit 1
  for update;
  if approval_id is null then
    raise exception 'A second admin must approve this support session (approve_support_request)' using errcode = '42501', hint = 'IMPERSONATION_APPROVAL_REQUIRED';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_support_start"(uuid, uuid, text, jsonb)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text, $4::jsonb)', v_hook::oid::regproc)
        using admin, target, reason, metadata;
    end if;
  end;
  update "better_supabase"."support_sessions" s set "ended_at" = now(), "ended_by" = 'admin'
  where s."admin_id" = admin and s."ended_at" is null;
  insert into "better_supabase"."support_sessions" ("admin_id", "target_id", "reason", "tenant_id", "read_only", "expires_at", "metadata")
  values (admin, target, coalesce(reason, ''), tenant, read_only, now() + ttl, coalesce(metadata, '{}'))
  returning "id" into session_id;
  update "better_supabase"."support_requests" x set "session_id" = session_id where x."id" = approval_id;
  select jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) into started from "better_supabase"."support_sessions" s where s."id" = session_id;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_support_start"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using session_id;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'support_session.started',
    category => 'security',
    target_type => 'user',
    record_id => target::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('session_id', session_id, 'reason', reason, 'read_only', read_only, 'request_id', approval_id, 'approved_by', approver),
    idempotency_key => 'support_session.started:' || session_id,
    actor_id => admin,
    support_session => session_id,
    impersonated_by => admin,
    impersonation_reason => reason
  );
  return started;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.support_target_claims (
  target uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  base jsonb;
begin
  select jsonb_build_object(
    'user_id', u.id,
    'authentication_method', 'support',
    'claims', jsonb_strip_nulls(jsonb_build_object(
      'sub', u.id::text,
      'aud', 'authenticated',
      'role', coalesce(nullif(u.role, ''), 'authenticated'),
      'email', u.email,
      'phone', nullif(u.phone, ''),
      'app_metadata', coalesce(u.raw_app_meta_data, '{}'),
      'user_metadata', coalesce(u.raw_user_meta_data, '{}'),
      'is_anonymous', u.is_anonymous,
      'aal', 'aal1',
      'amr', '[]'::jsonb,
      'session_id', gen_random_uuid()
    ))
  ) into base
  from auth.users u where u.id = target;
  if base is null then
    raise exception 'No user %', target using errcode = 'P0002', hint = 'IMPERSONATION_TARGET_MISSING';
  end if;
  return coalesce(permdock.custom_access_token_hook(base) -> 'claims', base -> 'claims');
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.update_invitation (
  invitation_id uuid,
  invitee_email text  DEFAULT NULL::text,
  invitee_role  text  DEFAULT NULL::text,
  prefill       jsonb DEFAULT NULL::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  current_invite "better_supabase"."invitations";
  updated "better_supabase"."invitations";
  tenant uuid;
  platform_current "better_supabase"."platform_invitations";
  platform_updated "better_supabase"."platform_invitations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if invitee_email is not null and btrim(invitee_email) = '' then
    raise exception 'The email address is empty' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  select * into current_invite from "better_supabase"."invitations" i
  where i."id" = invitation_id and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  for update;
  if current_invite."id" is null then
    select * into platform_current from "better_supabase"."platform_invitations" i
    where i."id" = invitation_id and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
    for update;
    if platform_current."id" is not null then
      if platform_current."expires_at" < now() then
        raise exception 'The invitation has expired; resend it to renew it' using errcode = 'P0002', hint = 'INVITATION_EXPIRED';
      end if;
      if not service and not (select coalesce(better_supabase.is_platform('platform.invite'), false)) then
        raise exception 'Not allowed to invite platform users' using errcode = '42501', hint = 'INVITATION_FORBIDDEN';
      end if;
      if invitee_role is not null and invitee_role is null then
        raise exception 'Unknown platform role %', invitee_role using errcode = '23514', hint = 'INVITATION_ROLE_UNKNOWN';
      end if;
      -- No platform role ceiling: holding the invite permission is enough.
      if invitee_email is not null then
        delete from "better_supabase"."platform_invitations" i
        where lower(i."email") = lower(btrim(invitee_email))
          and i."id" <> invitation_id and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null;
      end if;
      platform_updated := platform_current;
    if invitee_email is not null then
      platform_updated."email" := lower(btrim(invitee_email));
    end if;
    if invitee_role is not null then
      platform_updated."role" := invitee_role;
    end if;
    update "better_supabase"."platform_invitations" i
    set "email" = platform_updated."email",
      "role" = platform_updated."role"
    where i."id" = invitation_id
    returning * into platform_updated;
      perform better_supabase.audit_event(
    event_type => 'invitation.updated',
    category => 'membership',
    target_type => 'invitation',
    record_id => platform_updated."id"::text,
    metadata => jsonb_build_object('invitationId', platform_updated."id", 'organizationId', null, 'email', platform_updated."email", 'role', platform_updated."role")
  );
      return (jsonb_build_object(
    'id', platform_updated."id",
    'tenant', null,
    'email', platform_updated."email",
    'role', platform_updated."role",
    'expires_at', platform_updated."expires_at",
    'created_at', platform_updated."created_at",
    'invited_by', platform_updated."invited_by",
    'organization', null,
    'prefill', '{}'::jsonb,
    'token', null
  ) || "better_supabase"."invitation_extra"(platform_updated."id")) - 'token';
    end if;
    raise exception 'No open invitation %', invitation_id using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if current_invite."expires_at" < now() then
    raise exception 'The invitation has expired; resend it to renew it' using errcode = 'P0002', hint = 'INVITATION_EXPIRED';
  end if;
  tenant := current_invite."tenant_id";
  if not service and not coalesce(better_supabase.member_can(auth.uid(), tenant, 'members.invite'), false) then
    raise exception 'Not allowed to invite members' using errcode = '42501', hint = 'INVITATION_FORBIDDEN';
  end if;
  if better_supabase.tenant_disabled(tenant) or not exists (select 1 from "better_supabase"."organizations" o where o."id" = tenant) then
    raise exception 'The organization is not active' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if invitee_role is not null and false then
    raise exception 'Unknown role %', invitee_role using errcode = '23514', hint = 'INVITATION_ROLE_UNKNOWN';
  end if;
  if not service and (
    not better_supabase.can_assign(tenant, current_invite."role"::text)
    or (invitee_role is not null and not better_supabase.can_assign(tenant, (invitee_role)::text))
  ) then
    raise exception 'That role is above your own' using errcode = '42501', hint = 'INVITATION_ROLE_FORBIDDEN';
  end if;
  if invitee_email is not null and exists (
    select 1 from "public"."organization_memberships" m join auth.users u on u.id = m."user_id"
    where m."organization_id" = tenant and lower(u.email) = lower(btrim(invitee_email))
  ) then
    raise exception '% is already a member', invitee_email using errcode = '23505', hint = 'INVITATION_ALREADY_MEMBER';
  end if;
  if invitee_email is not null then
    delete from "better_supabase"."invitations" i
    where i."tenant_id" = tenant
      and lower(i."email") = lower(btrim(invitee_email))
      and i."id" <> invitation_id
      and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null;
  end if;

  updated := current_invite;
    if invitee_email is not null then
      updated."email" := lower(btrim(invitee_email));
    end if;
    if invitee_role is not null then
      updated."role" := invitee_role;
    end if;
    update "better_supabase"."invitations" i
    set "email" = updated."email",
      "role" = updated."role"
    where i."id" = invitation_id
    returning * into updated;
  perform better_supabase.audit_event(
    event_type => 'invitation.updated',
    category => 'membership',
    target_type => 'invitation',
    record_id => updated."id"::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', updated."id", 'organizationId', tenant::text, 'email', updated."email", 'role', updated."role")
  );
  return (jsonb_build_object(
    'id', updated."id",
    'tenant', updated."tenant_id",
    'email', updated."email",
    'role', updated."role",
    'expires_at', updated."expires_at",
    'created_at', updated."created_at",
    'invited_by', updated."invited_by",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = updated."tenant_id"),
    'prefill', '{}'::jsonb,
    'token', null
  ) || "better_supabase"."invitation_extra"(updated."id")) - 'token';
end;
$function$;

CREATE OR REPLACE FUNCTION public.sample_authz_version (
  args jsonb
)
  RETURNS bigint
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select better_supabase.caller_authz_version()
  where args is null or args is not null
$function$;

REVOKE ALL ON FUNCTION "public"."sample_authz_version"(jsonb) FROM PUBLIC, "anon";

ALTER TABLE "better_supabase"."platform_invitations"
  ADD CONSTRAINT "platform_invitations_accepted_by_fkey" FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."platform_invitations"
  ADD CONSTRAINT "platform_invitations_invited_by_fkey" FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX platform_invitations_accepted_by_idx ON better_supabase.platform_invitations USING btree (accepted_by);

CREATE INDEX platform_invitations_invited_by_idx ON better_supabase.platform_invitations USING btree (invited_by);

CREATE UNIQUE INDEX platform_invitations_open_email_idx ON better_supabase.platform_invitations USING btree (lower(email))
  WHERE ((accepted_at IS NULL) AND (declined_at IS NULL) AND (revoked_at IS NULL));

CREATE TRIGGER bsb_updated_at
  BEFORE UPDATE ON better_supabase.platform_invitations
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE POLICY "bsb_platform_invitations_read" ON "better_supabase"."platform_invitations"
  FOR SELECT
  TO "authenticated"
  USING (( SELECT better_supabase.platform_invitations_readable() AS platform_invitations_readable));

REVOKE ALL ON FUNCTION "better_supabase"."bootstrap_app"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."bootstrap_app"(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."platform_invitations_readable"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."platform_invitations_readable"() TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."request_approval"(uuid, text, text, text, text, jsonb, jsonb, text, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."request_approval"(uuid, text, text, text, text, jsonb, jsonb, text, jsonb, uuid) TO "authenticated", "service_role";

GRANT EXECUTE ON FUNCTION "public"."sample_authz_version"(jsonb) TO "authenticated";

REVOKE ALL ON FUNCTION "public"."sample_authz_version"(jsonb) FROM "postgres";

GRANT EXECUTE ON FUNCTION "public"."sample_authz_version"(jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."sample_authz_version"(jsonb) TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."platform_invitations" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."platform_invitations" TO "service_role";
