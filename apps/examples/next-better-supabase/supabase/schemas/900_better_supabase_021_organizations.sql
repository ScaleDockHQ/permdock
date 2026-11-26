-- better-supabase module: organizations
-- @bsb-block organizations@1 managed
-- @bsb-hash sha256:445f398bd5e10a6cf066d7c7f5182606ae68257514fbefa956b600095380e7d4
-- create_organization(attrs) with slug rules and an after-create hook, a deferred owner check, an assignment ceiling, and member functions (role change, remove, leave, transfer ownership) on the access contract.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create table "better_supabase"."organizations" (
  "id" uuid primary key default gen_random_uuid(),
  "name" text not null constraint bsb_organizations_name_check check (length(btrim("name")) > 0),
  "slug" text not null,
  "created_by" uuid references auth.users (id) on delete set null,
  "created_at" timestamptz not null default now(),
  "disabled_at" timestamptz,
  "deleted_at" timestamptz
);
create unique index organizations_slug_idx on "better_supabase"."organizations" (lower("slug"::text)) where "deleted_at" is null;
create index organizations_created_by_idx on "better_supabase"."organizations" ("created_by");
alter table "better_supabase"."organizations" add column "updated_at" timestamptz not null default now();
create trigger bsb_updated_at before update on "better_supabase"."organizations"
  for each row
  execute function better_supabase.set_updated_at('updated_at');
-- The Stripe customer the entitlements module reads (config.entitlements.customer).
alter table "better_supabase"."organizations" add column stripe_customer_id text unique;
alter table "better_supabase"."organizations" enable row level security;
revoke all on "better_supabase"."organizations" from public, anon, authenticated;
grant select on "better_supabase"."organizations" to authenticated;
grant all on "better_supabase"."organizations" to service_role;
create policy bsb_organizations_read on "better_supabase"."organizations"
  for select to authenticated
  using ("id" in (select better_supabase.member_organization_ids()));

alter table "better_supabase"."invitations" add constraint "invitations_organization_fkey"
  foreign key ("tenant_id") references "better_supabase"."organizations" ("id") on delete cascade;

-- Why a slug can't be used, or null: 'invalid' (length and pattern from
-- blocks.organizations.options), 'reserved' or 'taken'. except_organization skips the
-- organization being renamed.
create or replace function "better_supabase"."organization_slug_problem"(value text, except_organization uuid default null)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when value is null then null
    when length(value) < 2 or length(value) > 48 or value !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' then 'invalid'
    when false then 'reserved'
    when exists (
      select 1 from "better_supabase"."organizations" o
      where lower(o."slug"::text) = lower(value) and o."deleted_at" is null
        and o."id" is distinct from except_organization
    ) then 'taken'
  end
$$;
revoke execute on function "better_supabase"."organization_slug_problem"(text, uuid) from public, anon;
grant execute on function "better_supabase"."organization_slug_problem"(text, uuid) to authenticated, service_role;

-- Creates an organization from attrs (its name, slug and the columns in
-- blocks.organizations.options.attributes) and makes the caller its owner. The
-- service role passes the owner as attrs.owner_id.
create or replace function "better_supabase"."create_organization"(attrs jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  owner uuid := case when service then nullif(attrs ->> 'owner_id', '')::uuid else auth.uid() end;
  organization uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if owner is null then
    raise exception 'An organization needs an owner' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if better_supabase.user_disabled(owner) then
    raise exception 'The user is disabled' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  case "better_supabase"."organization_slug_problem"(coalesce(attrs ->> 'slug', ''), null)
    when 'invalid' then raise exception 'Invalid slug "%"', attrs ->> 'slug' using errcode = '23514', hint = 'ORGANIZATION_SLUG_INVALID';
    when 'reserved' then raise exception 'The slug "%" is reserved', attrs ->> 'slug' using errcode = '23514', hint = 'ORGANIZATION_SLUG_RESERVED';
    when 'taken' then raise exception 'The slug "%" is taken', attrs ->> 'slug' using errcode = '23505', hint = 'ORGANIZATION_SLUG_TAKEN';
    else null;
  end case;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_organization_create"(jsonb, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::jsonb, $2::uuid)', v_hook::oid::regproc)
        using attrs, owner;
    end if;
  end;
  insert into "better_supabase"."organizations" ("name", "slug", "created_by")
  select r."name", r."slug", owner
  from jsonb_populate_record(null::"better_supabase"."organizations", attrs) r
  returning "id" into organization;
  insert into "public"."organization_memberships" ("organization_id", "user_id", "role")
  values (organization, owner, 'owner');
  perform "better_supabase"."seed_tenant_defaults"(organization);
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_organization_create"(uuid, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid)', v_hook::oid::regproc)
        using organization, owner;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.created',
    category => 'configuration',
    target_type => 'organization',
    record_id => organization::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', owner, 'role', 'owner')
  );
  return organization;
end;
$$;

-- Updates the name, slug and attribute columns present in attrs.
create or replace function "better_supabase"."update_organization"(organization uuid, attrs jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.member_can(auth.uid(), organization, 'organization.update'), false) then
    raise exception 'Not allowed to update the organization' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if attrs ? 'slug' then
    case "better_supabase"."organization_slug_problem"(coalesce(attrs ->> 'slug', ''), organization)
      when 'invalid' then raise exception 'Invalid slug "%"', attrs ->> 'slug' using errcode = '23514', hint = 'ORGANIZATION_SLUG_INVALID';
      when 'reserved' then raise exception 'The slug "%" is reserved', attrs ->> 'slug' using errcode = '23514', hint = 'ORGANIZATION_SLUG_RESERVED';
      when 'taken' then raise exception 'The slug "%" is taken', attrs ->> 'slug' using errcode = '23505', hint = 'ORGANIZATION_SLUG_TAKEN';
      else null;
    end case;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_organization_update"(uuid, jsonb)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::jsonb)', v_hook::oid::regproc)
        using organization, attrs;
    end if;
  end;
  update "better_supabase"."organizations" o
  set "name" = case when attrs ? 'name' then r."name" else o."name" end,
    "slug" = case when attrs ? 'slug' then r."slug" else o."slug" end
  from jsonb_populate_record(null::"better_supabase"."organizations", attrs) r
  where o."id" = organization;
  if not found then
    raise exception 'No organization %', organization using errcode = 'P0002', hint = 'ORGANIZATION_NOT_FOUND';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_organization_update"(uuid, jsonb)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::jsonb)', v_hook::oid::regproc)
        using organization, attrs;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.updated',
    category => 'configuration',
    target_type => 'organization',
    record_id => organization::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', auth.uid())
  );
  return true;
end;
$$;

-- Deletes an organization (blocks.organizations.options.deleteMode: hard, with its memberships).
create or replace function "better_supabase"."delete_organization"(organization uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.member_can(auth.uid(), organization, 'organization.delete'), false) then
    raise exception 'Not allowed to delete the organization' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  delete from "better_supabase"."organizations" where "id" = organization;
  if not found then
    return false;
  end if;
  delete from "public"."organization_memberships" where "organization_id" = organization;
  perform better_supabase.audit_event(
    event_type => 'organization.deleted',
    category => 'configuration',
    target_type => 'organization',
    record_id => organization::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('mode', 'hard')
  );
  return true;
end;
$$;

-- Checked at commit, so one transaction can promote one owner and demote
-- another. An organization may have several owners.
create or replace function "better_supabase"."ensure_organization_owner"()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The row lock serializes concurrent demotions and leaves, so two
  -- transactions can't each remove a different last owner.
  perform 1 from "better_supabase"."organizations" o where o."id" = old."organization_id" for update;
  if found and not exists (
      select 1 from "public"."organization_memberships" m where m."organization_id" = old."organization_id" and m."role" = 'owner'
    ) then
    raise exception 'An organization needs an owner' using errcode = '23514', hint = 'ORGANIZATION_OWNER_REQUIRED';
  end if;
  return null;
end;
$$;
revoke execute on function "better_supabase"."ensure_organization_owner"() from public, anon, authenticated;
create constraint trigger "bsb_organization_owner" after update of "role", "organization_id" or delete on "public"."organization_memberships"
  deferrable initially deferred
  for each row execute function "better_supabase"."ensure_organization_owner"();

-- No client grants a role above their own permissions (can_assign), demotes
-- someone above them, or changes their own role. Only writes made as anon or
-- authenticated are checked: the service role, direct admin connections and
-- security definer functions (the module's own and the app's, which check
-- their own ceilings) pass.
-- The checks, as the module's owner, so the client needs no rights on the
-- roles tables. It only raises, so a direct call reveals nothing.
create or replace function "better_supabase"."guard_membership_role"(target_tenant uuid, target_member uuid, target_role text, previous_tenant uuid, previous_role text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_member = auth.uid() then
    raise exception 'You cannot change your own role' using errcode = '42501', hint = 'ORGANIZATION_SELF_ROLE';
  end if;
  if not better_supabase.can_assign(target_tenant, target_role::text)
    or (previous_tenant is not null and not better_supabase.can_assign(previous_tenant, previous_role::text)) then
    raise exception 'That role is above your own' using errcode = '42501', hint = 'ORGANIZATION_ROLE_CEILING';
  end if;
end;
$$;
revoke execute on function "better_supabase"."guard_membership_role"(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function "better_supabase"."guard_membership_role"(uuid, uuid, text, uuid, text) to authenticated, service_role;

-- Security invoker, so current_user is the role that wrote the row.
create or replace function "better_supabase"."guard_membership"()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not (current_user in ('anon', 'authenticated')) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new."role" is not distinct from old."role" then
    return new;
  end if;
  perform "better_supabase"."guard_membership_role"(
    new."organization_id", new."user_id", new."role"::text,
    case when tg_op = 'UPDATE' then old."organization_id" end,
    case when tg_op = 'UPDATE' then old."role"::text end
  );
  return new;
end;
$$;
create trigger "bsb_organization_role_guard" before insert or update on "public"."organization_memberships"
  for each row execute function "better_supabase"."guard_membership"();
revoke execute on function "better_supabase"."guard_membership"() from public, anon, authenticated;

-- Errors carry a code in the hint: ORGANIZATION_FORBIDDEN, ORGANIZATION_DISABLED, ORGANIZATION_NOT_MEMBER,
-- ORGANIZATION_SELF, ORGANIZATION_SELF_ROLE, ORGANIZATION_ROLE_CEILING, ORGANIZATION_ROLE_UNKNOWN, ORGANIZATION_OWNER_REQUIRED,
-- ORGANIZATION_ROLE_LAST.
create or replace function "better_supabase"."update_member_role"(organization uuid, member uuid, role text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  previous text;
  previous_assignable text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), organization, 'members.update_role'), false)) then
    raise exception 'Not allowed to change roles' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if not (exists (select 1 from "better_supabase"."organizations" o where o."id" = organization and o."deleted_at" is null and o."disabled_at" is null) and not better_supabase.tenant_disabled(organization)) then
    raise exception 'The organization is unavailable' using errcode = '42501', hint = 'ORGANIZATION_DISABLED';
  end if;
  select m."role", m."role"::text into previous, previous_assignable
  from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = member;
  if not found then
    raise exception 'Not a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  -- Checked here whatever blocks.organizations.options.assignmentGuard
  -- says: a guard that checks only client writes never sees this function's.
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and coalesce(member = auth.uid(), false) then
    raise exception 'You cannot change your own role' using errcode = '42501', hint = 'ORGANIZATION_SELF_ROLE';
  end if;
  if not better_supabase.can_assign(organization, previous_assignable)
    or not better_supabase.can_assign(organization, (role)::text) then
    raise exception 'That role is above your own' using errcode = '42501', hint = 'ORGANIZATION_ROLE_CEILING';
  end if;
  update "public"."organization_memberships" set "role" = role
  where "organization_id" = organization and "user_id" = member;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_member_change"(uuid, uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text)', v_hook::oid::regproc)
        using organization, member, 'role';
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.role_changed',
    category => 'membership',
    target_type => 'user',
    record_id => member::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', member, 'role', role, 'previousRole', previous)
  );
  return true;
end;
$$;

create or replace function "better_supabase"."remove_member"(organization uuid, member uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  current_role_value text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if member = auth.uid() then
    raise exception 'Leave the organization instead' using errcode = '22023', hint = 'ORGANIZATION_SELF';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), organization, 'members.remove'), false)) then
    raise exception 'Not allowed to remove members' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  select m."role"::text into current_role_value from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = member;
  if not found then
    raise exception 'Not a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  if not better_supabase.can_assign(organization, current_role_value) then
    raise exception 'That member''s role is above your own' using errcode = '42501', hint = 'ORGANIZATION_ROLE_CEILING';
  end if;
  delete from "public"."organization_memberships" where "organization_id" = organization and "user_id" = member;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_member_change"(uuid, uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text)', v_hook::oid::regproc)
        using organization, member, 'removed';
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.member_removed',
    category => 'membership',
    target_type => 'user',
    record_id => member::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', member)
  );
  return true;
end;
$$;

create or replace function "better_supabase"."leave_organization"(organization uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  delete from "public"."organization_memberships" where "organization_id" = organization and "user_id" = me;
  if not found then
    raise exception 'Not a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_member_change"(uuid, uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text)', v_hook::oid::regproc)
        using organization, me, 'left';
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.member_left',
    category => 'membership',
    target_type => 'user',
    record_id => me::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', me)
  );
  return true;
end;
$$;

-- The organizations whose last owner the member is: removing their
-- memberships (leaving, or deleting the account) would fail the owner check.
-- A member reads their own and the service role any member's. Another member's
-- list needs the remove permission (blocks.organizations.permissions.removeMember
-- or options.soleOwnedPermission) in every organization the list would name, and
-- in at least one organization of the member, so an offboarding run by HR can ask
-- first. Without it the call raises instead of returning a partial list. With
-- organization, the list names only that organization and the permission is
-- needed only there, so HR of one organization can ask about it alone.

create or replace function "better_supabase"."sole_owned_organizations"(member uuid default null, organization uuid default null)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_member uuid := coalesce(member, auth.uid());
  v_all boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or v_member = auth.uid();
  v_ids uuid[];
begin
  if v_member is null then
    raise exception 'Only the member or the service role can read this' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if not v_all and (case when organization is null then not exists (select 1 from "public"."organization_memberships" m
    where m."user_id" = v_member
      and coalesce(better_supabase.member_can(auth.uid(), m."organization_id", 'members.remove'), false)) else not coalesce(better_supabase.member_can(auth.uid(), organization, 'members.remove'), false) end) then
    raise exception 'Not allowed to read this member''s organizations' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  v_ids := coalesce((
    select array_agg(m."organization_id" order by m."organization_id")
    from "public"."organization_memberships" m
    where m."user_id" = v_member and m."role" = 'owner'
      and (organization is null or m."organization_id" = organization)
      and exists (select 1 from "better_supabase"."organizations" o where o."id" = m."organization_id")
      and not exists (
        select 1 from "public"."organization_memberships" y
        where y."organization_id" = m."organization_id" and y."user_id" <> v_member and y."role" = 'owner'
      )
  ), '{}');
  if not v_all and exists (
    select 1 from unnest(v_ids) t (id)
    where not coalesce(better_supabase.member_can(auth.uid(), t.id, 'members.remove'), false)
  ) then
    raise exception 'Not allowed to read this member''s organizations' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  return v_ids;
end;
$$;

-- Makes new_owner an owner in one transaction; a calling owner becomes
-- former_role (blocks.organizations.options.formerOwnerRole).
create or replace function "better_supabase"."transfer_ownership"(organization uuid, new_owner uuid, former_role text default 'admin')
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), organization, 'organization.transfer_ownership'), false)) then
    raise exception 'Not allowed to transfer ownership' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  -- Only an owner hands ownership on, so the permission alone can't make its
  -- holder an owner.
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not exists (
    select 1 from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = me and m."role" = 'owner'
  ) then
    raise exception 'Only an owner can transfer ownership' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if not (exists (select 1 from "better_supabase"."organizations" o where o."id" = organization and o."deleted_at" is null and o."disabled_at" is null) and not better_supabase.tenant_disabled(organization)) then
    raise exception 'The organization is unavailable' using errcode = '42501', hint = 'ORGANIZATION_DISABLED';
  end if;
  if not exists (select 1 from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = new_owner) then
    raise exception 'The new owner must be a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  if better_supabase.user_disabled(new_owner) then
    raise exception 'The new owner is disabled' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  -- One statement for both rows, so a statement-level guard on the number of
  -- owners sees the transfer as a whole.
  update "public"."organization_memberships" m set "role" = case
      when m."user_id" = new_owner then 'owner'
      else former_role
    end
  where m."organization_id" = organization
    and (m."user_id" = new_owner
      or (me is not null and me <> new_owner and m."user_id" = me and m."role" = 'owner'));
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_member_change"(uuid, uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text)', v_hook::oid::regproc)
        using organization, new_owner, 'owner';
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.ownership_transferred',
    category => 'membership',
    target_type => 'user',
    record_id => new_owner::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', new_owner, 'role', 'owner')
  );
  return true;
end;
$$;

-- Records that the caller opened the organization (the last_used_at column of
-- memberships, when it has one), for "recent organizations" lists.
create or replace function "better_supabase"."mark_used"(organization uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
begin
  return false;
end;
$$;

-- The role change for many members in one call (ADR 0853). It runs as the
-- caller: update_member_role is the security definer and does the checking,
-- once per distinct member in its own subtransaction, so every check and event
-- of the single call still runs. Returns { succeeded: [id], failed: [{ id,
-- code, message }] }; more than 500 members fail with BULK_TOO_MANY.
create or replace function "better_supabase"."update_member_roles"(organization uuid, members uuid[], role text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_variable
declare
  one uuid;
  succeeded jsonb := '[]'::jsonb;
  failed jsonb := '[]'::jsonb;
  failure_hint text;
  failure_message text;
begin
  if coalesce(cardinality(members), 0) > 500 then
    raise exception 'A bulk call takes at most 500 members' using errcode = '22023', hint = 'BULK_TOO_MANY';
  end if;
  for one in select distinct m from unnest(members) m loop
    begin
      perform "better_supabase"."update_member_role"(organization, one, role);
      succeeded := succeeded || to_jsonb(one::text);
    exception when others then
      get stacked diagnostics failure_hint = pg_exception_hint, failure_message = message_text;
      failed := failed || jsonb_build_object('id', one::text, 'code', failure_hint, 'message', failure_message);
    end;
  end loop;
  return jsonb_build_object('succeeded', succeeded, 'failed', failed);
end;
$$;

-- Makes organization the caller's active organization (blocks.permissions.activeTenant).
create or replace function "better_supabase"."switch_organization"(organization uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
begin
  if me is null or not exists (select 1 from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = me) then
    raise exception 'Not a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  if not (exists (select 1 from "better_supabase"."organizations" o where o."id" = organization and o."deleted_at" is null and o."disabled_at" is null) and not better_supabase.tenant_disabled(organization)) then
    raise exception 'The organization is unavailable' using errcode = '42501', hint = 'ORGANIZATION_DISABLED';
  end if;
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}') || jsonb_build_object('tenant_id', organization::text)
  where id = me;
  null;
  return jsonb_build_object('organization_id', organization, 'refresh', true);
end;
$$;
create or replace function "better_supabase"."list_my_organizations"()
returns table (
  id uuid,
  name text,
  slug text,
  role text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o."id", o."name", o."slug", m."role"::text
  from "public"."organization_memberships" m
  join "better_supabase"."organizations" o on o."id" = m."organization_id"
  where m."user_id" = (select auth.uid()) and o."deleted_at" is null and o."disabled_at" is null
    and not better_supabase.tenant_disabled(o."id")
  order by o."name"
$$;
create or replace function "better_supabase"."list_members"(organization uuid)
returns table (user_id uuid, role text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(better_supabase.member_can((select auth.uid()), organization, 'members.read'), false) then
    raise exception 'Not allowed to list members' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  return query
  select m."user_id", m."role"::text
  from "public"."organization_memberships" m
  where m."organization_id" = organization
  order by m."user_id";
end;
$$;

-- The members of an organization as a keyset page, by role then user. filters
-- is { role (a value or a list), sort, direction, facet, count, limit, after,
-- offset, paged, total, totalCap } (ADR 0749, 1077).
create or replace function "better_supabase"."page_organization_members"(tenant uuid, filters jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_organization_members.filters, '{}'::jsonb);
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
  if not coalesce(better_supabase.member_can((select auth.uid()), tenant, 'members.read'), false) then
    raise exception 'Not allowed to list members' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('role') then
      raise exception 'facet is one of role' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
    end if;
    with s as (
      select (case v_facet when 'role' then (m."role"::text)::text end) as v
      from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
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
      select 1 from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('role', 'userId') then
    raise exception 'sort is one of role, userId' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."role"::text)::text, (m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."role"::text, m."user_id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by m."role"::text asc, m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."role"::text)::text, (m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."role"::text <= (v_after ->> 0)::text and ((m."role"::text < (v_after ->> 0)::text) or (m."role"::text = (v_after ->> 0)::text and m."user_id" > (v_after ->> 1)::uuid))))
      order by m."role"::text desc, m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort = 'role' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."role"::text)::text, (m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."role"::text, m."user_id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by m."role"::text asc, m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort = 'role' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."role"::text)::text, (m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."role"::text <= (v_after ->> 0)::text and ((m."role"::text < (v_after ->> 0)::text) or (m."role"::text = (v_after ->> 0)::text and m."user_id" > (v_after ->> 1)::uuid))))
      order by m."role"::text desc, m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort = 'userId' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 1) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."user_id") > ((v_after ->> 0)::uuid))
      order by m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort = 'userId' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 1) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."user_id") < ((v_after ->> 0)::uuid))
      order by m."user_id" desc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$$;

create or replace function "better_supabase"."list_organization_invitations"(organization uuid)
returns table (
  id uuid,
  email text,
  role text,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(better_supabase.member_can((select auth.uid()), organization, 'members.invite'), false) then
    raise exception 'Not allowed to list invitations' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  return query
  select i."id", i."email", i."role"::text, i."expires_at"
  from "better_supabase"."invitations" i
  where i."tenant_id" = organization and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null and i."expires_at" >= now()
  order by i."expires_at" desc;
end;
$$;

-- The open invitations of an organization as a keyset page, latest expiry
-- first. filters is { role (a value or a list), search, sort, direction, facet,
-- count, limit, after, offset, paged, total, totalCap } (ADR 0749, 0923).
create or replace function "better_supabase"."page_organization_invitations"(tenant uuid, filters jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_organization_invitations.filters, '{}'::jsonb);
  v_search text := case when nullif(trim(v_filters ->> 'search'), '') is null then null
    else '%' || replace(replace(replace(trim(v_filters ->> 'search'), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
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
  if not coalesce(better_supabase.member_can((select auth.uid()), tenant, 'members.invite'), false) then
    raise exception 'Not allowed to list invitations' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('role') then
      raise exception 'facet is one of role' using errcode = '22023', hint = 'INVITATION_INVALID';
    end if;
    with s as (
      select (case v_facet when 'role' then (i."role"::text)::text end) as v
      from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
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
      select 1 from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('expiresAt', 'email') then
    raise exception 'sort is one of expiresAt, email' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((coalesce(i."expires_at", 'infinity'::timestamptz))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (coalesce(i."expires_at", 'infinity'::timestamptz) >= (v_after ->> 0)::timestamptz and ((coalesce(i."expires_at", 'infinity'::timestamptz) > (v_after ->> 0)::timestamptz) or (coalesce(i."expires_at", 'infinity'::timestamptz) = (v_after ->> 0)::timestamptz and i."id" < (v_after ->> 1)::uuid))))
      order by coalesce(i."expires_at", 'infinity'::timestamptz) asc, i."id" desc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((coalesce(i."expires_at", 'infinity'::timestamptz))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (coalesce(i."expires_at", 'infinity'::timestamptz), i."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by coalesce(i."expires_at", 'infinity'::timestamptz) desc, i."id" desc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((coalesce(i."expires_at", 'infinity'::timestamptz))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (coalesce(i."expires_at", 'infinity'::timestamptz) >= (v_after ->> 0)::timestamptz and ((coalesce(i."expires_at", 'infinity'::timestamptz) > (v_after ->> 0)::timestamptz) or (coalesce(i."expires_at", 'infinity'::timestamptz) = (v_after ->> 0)::timestamptz and i."id" < (v_after ->> 1)::uuid))))
      order by coalesce(i."expires_at", 'infinity'::timestamptz) asc, i."id" desc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((coalesce(i."expires_at", 'infinity'::timestamptz))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (coalesce(i."expires_at", 'infinity'::timestamptz), i."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by coalesce(i."expires_at", 'infinity'::timestamptz) desc, i."id" desc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort = 'email' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((lower(i."email"))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (lower(i."email"), i."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by lower(i."email") asc, i."id" asc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort = 'email' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((lower(i."email"))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (lower(i."email") <= (v_after ->> 0)::text and ((lower(i."email") < (v_after ->> 0)::text) or (lower(i."email") = (v_after ->> 0)::text and i."id" > (v_after ->> 1)::uuid))))
      order by lower(i."email") desc, i."id" asc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$$;

-- The organization page in one call. It runs as the caller and reads through
-- the listing functions, so the permissions to list members and invitations
-- apply. Seats come from billing_status and are null when the caller may not
-- read billing.
create or replace function "better_supabase"."organization_overview"(organization uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_org jsonb;
  v_seats integer;
begin
  select to_jsonb(o) into v_org
  from "better_supabase"."list_my_organizations"() o
  where o.id = organization_overview.organization;
  if v_org is null then
    raise exception 'Not a member of this organization' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  
  return jsonb_build_object(
    'id', v_org ->> 'id',
    'name', v_org ->> 'name',
    'slug', v_org -> 'slug',
    'role', v_org ->> 'role',
    'seats', v_seats,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', m.user_id, 'role', m.role,
        'roles', coalesce(to_jsonb(m) -> 'roles', jsonb_build_array(m.role)),
        'disabledAt', to_jsonb(m) -> 'disabled_at')
        order by m.user_id)
      from "better_supabase"."list_members"(organization_overview.organization) m
    ), '[]'::jsonb),
    'invitations', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', i.id, 'email', i.email, 'role', i.role, 'expiresAt', to_jsonb(i) -> 'expires_at')
          order by i.email)
        from "better_supabase"."list_organization_invitations"(organization_overview.organization) i
      ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function "better_supabase"."create_organization"(jsonb) from public, anon;
grant execute on function "better_supabase"."create_organization"(jsonb) to authenticated, service_role;
revoke execute on function "better_supabase"."update_organization"(uuid, jsonb) from public, anon;
grant execute on function "better_supabase"."update_organization"(uuid, jsonb) to authenticated, service_role;
revoke execute on function "better_supabase"."delete_organization"(uuid) from public, anon;
grant execute on function "better_supabase"."delete_organization"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."update_member_role"(uuid, uuid, text) from public, anon;
grant execute on function "better_supabase"."update_member_role"(uuid, uuid, text) to authenticated, service_role;
revoke execute on function "better_supabase"."update_member_roles"(uuid, uuid[], text) from public, anon;
grant execute on function "better_supabase"."update_member_roles"(uuid, uuid[], text) to authenticated, service_role;
revoke execute on function "better_supabase"."remove_member"(uuid, uuid) from public, anon;
grant execute on function "better_supabase"."remove_member"(uuid, uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."leave_organization"(uuid) from public, anon;
grant execute on function "better_supabase"."leave_organization"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."sole_owned_organizations"(uuid, uuid) from public, anon;
grant execute on function "better_supabase"."sole_owned_organizations"(uuid, uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."transfer_ownership"(uuid, uuid, text) from public, anon;
grant execute on function "better_supabase"."transfer_ownership"(uuid, uuid, text) to authenticated, service_role;
revoke execute on function "better_supabase"."mark_used"(uuid) from public, anon;
grant execute on function "better_supabase"."mark_used"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."switch_organization"(uuid) from public, anon;
grant execute on function "better_supabase"."switch_organization"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."list_my_organizations"() from public, anon;
grant execute on function "better_supabase"."list_my_organizations"() to authenticated, service_role;
revoke execute on function "better_supabase"."list_members"(uuid) from public, anon;
grant execute on function "better_supabase"."list_members"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."page_organization_members"(uuid, jsonb) from public, anon;
grant execute on function "better_supabase"."page_organization_members"(uuid, jsonb) to authenticated, service_role;
revoke execute on function "better_supabase"."organization_overview"(uuid) from public, anon;
grant execute on function "better_supabase"."organization_overview"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."list_organization_invitations"(uuid) from public, anon;
grant execute on function "better_supabase"."list_organization_invitations"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."page_organization_invitations"(uuid, jsonb) from public, anon;
grant execute on function "better_supabase"."page_organization_invitations"(uuid, jsonb) to authenticated, service_role;

create table "better_supabase"."organization_profiles" (
  "tenant_id" uuid primary key,
  "vat_id" text,
  "registration_id" text,
  "default_rate" numeric,
  "currency" text,
  "updated_at" timestamptz not null default now()
);
alter table "better_supabase"."organization_profiles" enable row level security;
revoke all on "better_supabase"."organization_profiles" from public, anon, authenticated;
grant select on "better_supabase"."organization_profiles" to authenticated;
grant all on "better_supabase"."organization_profiles" to service_role;
create policy bsb_organization_profiles_read on "better_supabase"."organization_profiles"
  for select to authenticated
  using ("tenant_id" in (select better_supabase.member_organization_ids()));

create table "better_supabase"."organization_payment_accounts" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "iban" text not null,
  "bic" text,
  "holder" text,
  "label" text,
  "is_primary" boolean not null default false,
  "updated_at" timestamptz not null default now(),
  unique ("tenant_id", "iban")
);
create unique index organization_payment_accounts_primary_idx
  on "better_supabase"."organization_payment_accounts" ("tenant_id") where "is_primary";
alter table "better_supabase"."organization_payment_accounts" enable row level security;
revoke all on "better_supabase"."organization_payment_accounts" from public, anon, authenticated;
grant select on "better_supabase"."organization_payment_accounts" to authenticated;
grant all on "better_supabase"."organization_payment_accounts" to service_role;
create policy bsb_organization_payment_accounts_read on "better_supabase"."organization_payment_accounts"
  for select to authenticated
  using ("tenant_id" in (select better_supabase.member_organization_ids()));

-- The organization's VAT, registration, default rate, currency and payment
-- accounts. An IBAN matches on a repeat import. A missing value leaves the
-- stored one, and the stored primary account stays unless an account says
-- isPrimary. A VAT number that is only a country prefix is skipped.
create or replace function "better_supabase"."import_organization_profile"(run uuid, item jsonb, subject_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_data jsonb := import_organization_profile.item -> 'data';
  v_tenant uuid := (import_organization_profile.item ->> 'tenant')::uuid;
  v_vat text := nullif(upper(btrim(v_data ->> 'vatId')), '');
  v_warnings jsonb := '[]'::jsonb;
  v_account jsonb;
  v_iban text;
  v_primary boolean;
  v_id uuid;
  v_updated timestamptz;
begin
  if jsonb_typeof(v_data) is distinct from 'object' then
    raise exception 'an organization profile needs data' using errcode = '22023', hint = 'IMPORT_ITEM_INVALID';
  end if;
  if v_vat ~ '^[A-Z]{2}$' then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'IMPORT_VAT_PREFIX', 'message', 'a VAT number that is only a country prefix was skipped'));
    v_vat := null;
  end if;
  insert into "better_supabase"."organization_profiles" ("tenant_id") values (v_tenant) on conflict ("tenant_id") do nothing;
  if exists (
    select 1 from "better_supabase"."organization_profiles" x
    where x."tenant_id" = v_tenant
      and (v_vat is null or x."vat_id" is not distinct from v_vat)
      and (v_data ->> 'registrationId' is null or x."registration_id" is not distinct from nullif(btrim(v_data ->> 'registrationId'), ''))
      and (v_data ->> 'defaultRate' is null or x."default_rate" is not distinct from (v_data ->> 'defaultRate')::numeric)
      and (v_data ->> 'currency' is null or x."currency" is not distinct from nullif(btrim(v_data ->> 'currency'), ''))
  ) then
    v_updated := (select x."updated_at" from "better_supabase"."organization_profiles" x where x."tenant_id" = v_tenant);
  else
    update "better_supabase"."organization_profiles" x set
      "vat_id" = coalesce(v_vat, x."vat_id"),
      "registration_id" = coalesce(nullif(btrim(v_data ->> 'registrationId'), ''), x."registration_id"),
      "default_rate" = coalesce((v_data ->> 'defaultRate')::numeric, x."default_rate"),
      "currency" = coalesce(nullif(btrim(v_data ->> 'currency'), ''), x."currency"),
      "updated_at" = now()
    where x."tenant_id" = v_tenant
    returning x."updated_at" into v_updated;
  end if;
  if jsonb_typeof(v_data -> 'accounts') = 'array' then
    for v_account in select value from jsonb_array_elements(v_data -> 'accounts') loop
      v_iban := upper(regexp_replace(coalesce(v_account ->> 'iban', ''), '\s', '', 'g'));
      if not better_supabase.validate_iban(v_iban) then
        raise exception 'a payment account needs a valid IBAN' using errcode = '22023', hint = 'IMPORT_ITEM_INVALID';
      end if;
      v_primary := case when v_account ? 'isPrimary' then (v_account ->> 'isPrimary')::boolean else null end;
      select x."id" into v_id from "better_supabase"."organization_payment_accounts" x
      where x."tenant_id" = v_tenant and x."iban" = v_iban
        and x."bic" is not distinct from coalesce(nullif(upper(btrim(v_account ->> 'bic')), ''), x."bic")
        and x."holder" is not distinct from coalesce(nullif(btrim(v_account ->> 'holder'), ''), x."holder")
        and x."label" is not distinct from coalesce(nullif(btrim(v_account ->> 'label'), ''), x."label")
        and (v_primary is null or x."is_primary" = v_primary);
      if v_id is null then
        if v_primary is true then
          update "better_supabase"."organization_payment_accounts" x set "is_primary" = false where x."tenant_id" = v_tenant and x."iban" <> v_iban;
        end if;
        insert into "better_supabase"."organization_payment_accounts" ("tenant_id", "iban", "bic", "holder", "label", "is_primary")
        values (v_tenant, v_iban, nullif(upper(btrim(v_account ->> 'bic')), ''), nullif(btrim(v_account ->> 'holder'), ''),
          nullif(btrim(v_account ->> 'label'), ''), coalesce(v_primary, false))
        on conflict ("tenant_id", "iban") do update set
          "bic" = coalesce(excluded."bic", "better_supabase"."organization_payment_accounts"."bic"),
          "holder" = coalesce(excluded."holder", "better_supabase"."organization_payment_accounts"."holder"),
          "label" = coalesce(excluded."label", "better_supabase"."organization_payment_accounts"."label"),
          "is_primary" = case when v_primary is true then true else "better_supabase"."organization_payment_accounts"."is_primary" end,
          "updated_at" = now();
      end if;
    end loop;
  end if;
  return jsonb_build_object('subjectId', v_tenant, 'updatedAt', coalesce(v_updated, now()), 'warnings', v_warnings);
end;
$$;
revoke execute on function "better_supabase"."import_organization_profile"(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function "better_supabase"."import_organization_profile"(uuid, jsonb, text) to service_role;

create or replace function "better_supabase"."organization_profile_updated_at"(subject_id text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select x."updated_at" from "better_supabase"."organization_profiles" x where x."tenant_id"::text = organization_profile_updated_at.subject_id
$$;
revoke execute on function "better_supabase"."organization_profile_updated_at"(text) from public, anon, authenticated;
grant execute on function "better_supabase"."organization_profile_updated_at"(text) to service_role;
