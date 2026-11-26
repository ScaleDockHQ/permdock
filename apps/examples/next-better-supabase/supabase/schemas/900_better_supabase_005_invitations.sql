-- better-supabase module: invitations
-- @bsb-block invitations@2 managed
-- @bsb-hash sha256:e1fa0e4b77e583ad0f19ef3a29b7a4b2414ab39490b6747c9432b4ab1dc7073e
-- invite_member(tenant, email, role) returns a single-use token whose hash is stored; accept_invitation(token) checks the signed-in user's confirmed email and, again, the inviter's authority. Roles follow the access model; a null tenant invites to a platform role, stored in platform_invitations.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create table "better_supabase"."invitations" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "email" text not null,
  "role" text not null,
  "token_hash" text not null unique,
  "expires_at" timestamptz not null,
  "accepted_at" timestamptz
);
alter table "better_supabase"."invitations" alter column "tenant_id" set not null;
alter table "better_supabase"."invitations" alter column "role" drop default;
alter table "better_supabase"."invitations" add column "invited_by" uuid references auth.users (id) on delete set null;
alter table "better_supabase"."invitations" add column "created_at" timestamptz not null default now();
alter table "better_supabase"."invitations" add column "accepted_by" uuid references auth.users (id) on delete set null;
alter table "better_supabase"."invitations" add column "declined_at" timestamptz;
alter table "better_supabase"."invitations" add column "revoked_at" timestamptz;
create unique index invitations_open_email_idx
  on "better_supabase"."invitations" ("tenant_id", lower("email")) where "accepted_at" is null and "declined_at" is null and "revoked_at" is null;
create index invitations_tenant_created_idx on "better_supabase"."invitations" ("tenant_id", "created_at");
alter table "better_supabase"."invitations" add column "updated_at" timestamptz not null default now();
create trigger bsb_updated_at before update on "better_supabase"."invitations"
  for each row
  execute function better_supabase.set_updated_at('updated_at');
create index invitations_invited_by_idx on "better_supabase"."invitations" ("invited_by");
create index invitations_accepted_by_idx on "better_supabase"."invitations" ("accepted_by");

alter table "better_supabase"."invitations" enable row level security;
revoke all on "better_supabase"."invitations" from public, anon, authenticated;
grant select on "better_supabase"."invitations" to authenticated;
grant all on "better_supabase"."invitations" to service_role;

-- PL/pgSQL resolves tenant_ids_with when it runs, so this file installs
-- before the access module's.
create or replace function "better_supabase"."invitation_tenant_ids"()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query select better_supabase.tenant_ids_with('members.invite');
end;
$$;
revoke execute on function "better_supabase"."invitation_tenant_ids"() from public, anon;
grant execute on function "better_supabase"."invitation_tenant_ids"() to authenticated, service_role;
create policy bsb_invitations_read on "better_supabase"."invitations"
  for select to authenticated
  using ("tenant_id" in (select "better_supabase"."invitation_tenant_ids"()));

-- Invitations to a platform role (the catalog model's platform assignments).
create table "better_supabase"."platform_invitations" (
  "id" uuid primary key default gen_random_uuid(),
  "email" text not null,
  "role" text not null,
  "token_hash" text not null unique,
  "expires_at" timestamptz not null,
  "accepted_at" timestamptz
);
alter table "better_supabase"."platform_invitations" add column "invited_by" uuid references auth.users (id) on delete set null;
alter table "better_supabase"."platform_invitations" add column "created_at" timestamptz not null default now();
alter table "better_supabase"."platform_invitations" add column "accepted_by" uuid references auth.users (id) on delete set null;
alter table "better_supabase"."platform_invitations" add column "declined_at" timestamptz;
alter table "better_supabase"."platform_invitations" add column "revoked_at" timestamptz;

create unique index platform_invitations_open_email_idx
  on "better_supabase"."platform_invitations" (lower("email")) where "accepted_at" is null and "declined_at" is null and "revoked_at" is null;
alter table "better_supabase"."platform_invitations" add column "updated_at" timestamptz not null default now();
create trigger bsb_updated_at before update on "better_supabase"."platform_invitations"
  for each row
  execute function better_supabase.set_updated_at('updated_at');
create index platform_invitations_invited_by_idx on "better_supabase"."platform_invitations" ("invited_by");
create index platform_invitations_accepted_by_idx on "better_supabase"."platform_invitations" ("accepted_by");

alter table "better_supabase"."platform_invitations" enable row level security;
revoke all on "better_supabase"."platform_invitations" from public, anon, authenticated;
grant select on "better_supabase"."platform_invitations" to authenticated;
grant all on "better_supabase"."platform_invitations" to service_role;
create or replace function "better_supabase"."platform_invitations_readable"()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  return (select coalesce(better_supabase.is_platform('platform.invite'), false));
end;
$$;
revoke execute on function "better_supabase"."platform_invitations_readable"() from public, anon;
grant execute on function "better_supabase"."platform_invitations_readable"() to authenticated, service_role;
create policy bsb_platform_invitations_read on "better_supabase"."platform_invitations"
  for select to authenticated
  using ((select "better_supabase"."platform_invitations_readable"()));

-- The keys an invitation_preview_extra(invitation uuid) hook returns for an
-- invitation, such as a role's display name; {} without the hook. The
-- module's functions merge them into every invitation they return.
create or replace function "better_supabase"."invitation_extra"(invitation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  hook regprocedure := to_regprocedure('"public"."invitation_preview_extra"(uuid)');
  extra jsonb;
begin
  if hook is null or invitation is null then
    return '{}'::jsonb;
  end if;
  -- Not a literal name, so plpgsql_check passes without the hook.
  execute format('select %s($1)', hook::oid::regproc) into extra using invitation;
  return coalesce(extra, '{}'::jsonb);
end;
$$;
revoke execute on function "better_supabase"."invitation_extra"(uuid) from public, anon, authenticated;

-- Invites email to tenant (null: a platform invitation) with role, a catalog
-- role id or key under blocks.permissions.model 'catalog'. Returns the invitation
-- and its token; only the token's hash is stored. An open invitation for
-- the same email is replaced.

create or replace function "better_supabase"."invite_member"(
  tenant uuid,
  invitee_email text,
  invitee_role text,
  valid_for interval default '7 days',
  prefill jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- The 0.4 signature: returns the token only.

create or replace function "better_supabase"."create_invitation"(
  organization uuid,
  invitee_email text,
  invitee_role text default 'member',
  valid_for interval default '7 days'
)
returns text
language sql
security invoker
set search_path = ''
as $$
  select "better_supabase"."invite_member"($1, $2, $3, $4) ->> 'token'
$$;

-- A new token and expiry for an open invitation; the old token stops working.
create or replace function "better_supabase"."resend_invitation"(invitation_id uuid, valid_for interval default '7 days')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Invites like invite_member when the tenant has a seat left: members counted
-- against the numeric `seats` entitlement, in one transaction. A plan without
-- a numeric seats value has no cap. It runs with the caller's rights: the
-- count sees the memberships the caller can read, the seats entitlement is
-- the member's read, and invite_member checks the invite permission.
create or replace function "better_supabase"."invite_within_seats"(
  tenant uuid,
  invitee_email text,
  invitee_role text,
  valid_for interval default '7 days'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_variable
declare
  used integer;
  cap jsonb;
begin
  cap := "better_supabase"."entitlement_value"(tenant, 'seats');
  select count(*) into used from "public"."organization_memberships" m where m."organization_id" = tenant;
  if cap is not null and jsonb_typeof(cap) = 'number' and used >= (cap #>> '{}')::numeric then
    raise exception 'The plan has no seat left' using errcode = '22023', hint = 'INVITATION_NO_SEAT';
  end if;
  return "better_supabase"."invite_member"(tenant, invitee_email, invitee_role, valid_for);
end;
$$;

-- resend_invitation for up to 1000 invitations in one call, all or nothing;
-- returns each invitation with its new token, in the order given.
create or replace function "better_supabase"."resend_invitations"(invitation_ids uuid[], valid_for interval default '7 days')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_id uuid;
  v_sent jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(invitation_ids), 0) > 1000 then
    raise exception 'Resend at most 1000 invitations in one call' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  for v_id in select x from unnest(invitation_ids) with ordinality u(x, n) where x is not null group by x order by min(n) loop
    v_sent := v_sent || jsonb_build_array("better_supabase"."resend_invitation"(v_id, valid_for));
  end loop;
  return v_sent;
end;
$$;

-- A new email, role or prefill for an open invitation that has not expired;
-- null keeps the current value. The caller needs what invite_member needs, and may assign
-- both the current and the new role. The token and expiry stay, and another
-- open invitation for the new email is replaced. on_accept replaces the roles
-- or teams it names, with the checks invite_member makes. Returns the
-- invitation without its token.

create or replace function "better_supabase"."update_invitation"(
  invitation_id uuid,
  invitee_email text default null,
  invitee_role text default null,
  prefill jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Revokes an open invitation (deletes it when revokedAt is mapped to null).
create or replace function "better_supabase"."revoke_invitation"(invitation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- The invitee declines with the token, signed in or not.
create or replace function "better_supabase"."decline_invitation"(token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function "better_supabase"."decline_invitation_by_id"(invitation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- What an invitation link shows before sign-in: status (pending, accepted,
-- declined, revoked or expired), email, role, organization (id plus
-- blocks.invitations.options.previewColumns) and prefill. Null for an unknown token.
-- An invitation_preview_extra(invitation uuid) returns jsonb hook adds its
-- keys, such as a role's display name or branding from another table.
create or replace function "better_supabase"."invitation_preview"(token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

create or replace function "better_supabase"."accepting_invitation"()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('better_supabase.accepting_invitation', true), '')::uuid
$$;

-- Accepts with the token for the signed-in user, whose confirmed email must
-- match, and returns the tenant (null for a platform invitation).
create or replace function "better_supabase"."accept_invitation"(token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function "better_supabase"."accept_invitation_by_id"(invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- The caller's open invitations, for an in-app inbox: the invitation without
-- its token, its organization (id plus previewColumns) and the keys an
-- invitation_preview_extra(invitation uuid) hook adds.
create or replace function "better_supabase"."my_invitations"()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke execute on function "better_supabase"."invite_member"(uuid, text, text, interval, jsonb) from public, anon;
grant execute on function "better_supabase"."invite_member"(uuid, text, text, interval, jsonb) to authenticated, service_role;
revoke execute on function "better_supabase"."invite_within_seats"(uuid, text, text, interval) from public, anon;
grant execute on function "better_supabase"."invite_within_seats"(uuid, text, text, interval) to authenticated, service_role;
revoke execute on function "better_supabase"."create_invitation"(uuid, text, text, interval) from public, anon;
grant execute on function "better_supabase"."create_invitation"(uuid, text, text, interval) to authenticated, service_role;
revoke execute on function "better_supabase"."resend_invitation"(uuid, interval) from public, anon;
grant execute on function "better_supabase"."resend_invitation"(uuid, interval) to authenticated, service_role;
revoke execute on function "better_supabase"."resend_invitations"(uuid[], interval) from public, anon;
grant execute on function "better_supabase"."resend_invitations"(uuid[], interval) to authenticated, service_role;
revoke execute on function "better_supabase"."update_invitation"(uuid, text, text, jsonb) from public, anon;
grant execute on function "better_supabase"."update_invitation"(uuid, text, text, jsonb) to authenticated, service_role;
revoke execute on function "better_supabase"."revoke_invitation"(uuid) from public, anon;
grant execute on function "better_supabase"."revoke_invitation"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."decline_invitation"(text) from public;
grant execute on function "better_supabase"."decline_invitation"(text) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."invitation_preview"(text) from public;
grant execute on function "better_supabase"."invitation_preview"(text) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."accept_invitation"(text) from public, anon;
grant execute on function "better_supabase"."accept_invitation"(text) to authenticated;
revoke execute on function "better_supabase"."accept_invitation_by_id"(uuid) from public, anon;
grant execute on function "better_supabase"."accept_invitation_by_id"(uuid) to authenticated;
revoke execute on function "better_supabase"."decline_invitation_by_id"(uuid) from public, anon;
grant execute on function "better_supabase"."decline_invitation_by_id"(uuid) to authenticated;
revoke execute on function "better_supabase"."my_invitations"() from public, anon;
grant execute on function "better_supabase"."my_invitations"() to authenticated;
revoke execute on function "better_supabase"."accepting_invitation"() from public, anon;
grant execute on function "better_supabase"."accepting_invitation"() to authenticated, service_role;

-- Tenant isolation (ADR 0099): permissive policies combine with or, so one
-- the app adds would widen the block's. These restrictive policies keep each
-- table to the caller's organizations and what the block's policies grant.
create policy bsb_tenant_scope_select on "better_supabase"."invitations" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select "better_supabase"."invitation_tenant_ids"()))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."invitations" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."invitations" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."invitations" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));
