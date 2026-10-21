SET local check_function_bodies = off;

DROP VIEW "permdock"."permdock_ceiling";

CREATE TABLE "better_supabase"."share_links" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    uuid                     NOT NULL,
  "subject_type" text                     NOT NULL,
  "subject_id"   text                     NOT NULL,
  "token_hash"   text                     NOT NULL,
  "role"         text                     NOT NULL DEFAULT 'view'::text,
  "version"      integer                  NOT NULL DEFAULT 1,
  "expires_at"   timestamp with time zone,
  "revoked_at"   timestamp with time zone,
  "max_uses"     integer,
  "created_by"   uuid,
  "leaf_id"      text,
  "version_id"   uuid,
  "use_count"    integer                  NOT NULL DEFAULT 0,
  CONSTRAINT "share_links_pkey" PRIMARY KEY (id),
  CONSTRAINT "share_links_token_hash_key" UNIQUE (token_hash)
);

ALTER TABLE "better_supabase"."share_links"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."subject_user_state" (
  "subject_type"   text                     NOT NULL,
  "subject_id"     text                     NOT NULL,
  "user_id"        uuid                     NOT NULL,
  "starred_at"     timestamp with time zone,
  "last_opened_at" timestamp with time zone,
  CONSTRAINT "subject_user_state_pkey" PRIMARY KEY (subject_type, subject_id, user_id)
);

ALTER TABLE "better_supabase"."subject_user_state"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."subject_views" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"       uuid                     NOT NULL,
  "subject_type"    text                     NOT NULL,
  "subject_id"      text                     NOT NULL,
  "version"         integer                  NOT NULL DEFAULT 1,
  "viewer_kind"     text                     NOT NULL,
  "viewer"          text,
  "first_viewed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_viewed_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "view_count"      integer                  NOT NULL DEFAULT 1,
  CONSTRAINT "subject_views_pkey" PRIMARY KEY (id),
  CONSTRAINT "subject_views_tenant_id_subject_type_subject_id_viewer_kind_key" UNIQUE (tenant_id, subject_type, subject_id, viewer_kind, viewer)
);

ALTER TABLE "better_supabase"."subject_views"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "permdock"."approval_delegations" (
  "id"          text                     NOT NULL DEFAULT (gen_random_uuid())::text,
  "delegate"    uuid                     NOT NULL,
  "tenant"      text,
  "permissions" text[],
  "resources"   text[],
  "from"        timestamp with time zone NOT NULL DEFAULT now(),
  "until"       timestamp with time zone NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "approval_delegations_pkey" PRIMARY KEY (id),
  CONSTRAINT "approval_delegations_window" CHECK (("from" < until)),
  "delegator"   uuid                     NOT NULL DEFAULT permdock.permdock_user_id(),
  CONSTRAINT "approval_delegations_distinct" CHECK ((delegator <> delegate))
);

ALTER TABLE "permdock"."approval_delegations"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "permdock"."approval_requests" (
  "token"        text                     NOT NULL,
  "body"         jsonb                    NOT NULL,
  "status"       text                     NOT NULL,
  "tenant"       text,
  "principal_id" text,
  "actor_id"     text,
  "session"      text,
  "approvals"    integer                  NOT NULL DEFAULT 0,
  "created_at"   text                     NOT NULL,
  "expires_at"   timestamp with time zone NOT NULL,
  "consumed_at"  timestamp with time zone,
  CONSTRAINT "approval_requests_pkey" PRIMARY KEY (token),
  CONSTRAINT "approval_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text])))
);

ALTER TABLE "permdock"."approval_requests"
  ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION better_supabase.actor_may_write()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select case
    when auth.jwt() is null then true
    when auth.jwt() -> 'act' ->> 'kind' = 'support'
      then coalesce(auth.jwt() -> 'act' -> 'read_only' = 'false'::jsonb, false)
    when auth.jwt() -> 'act' ->> 'kind' = 'agent'
      then coalesce(auth.jwt() -> 'act' -> 'read_only', 'false'::jsonb) = 'false'::jsonb
    when auth.jwt() -> 'act' ->> 'kind' is not null then false
    when auth.jwt() -> 'act' ->> 'session_id' is not null
      and auth.jwt() -> 'act' ->> 'kind' is null then false
    else true
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.create_share_link (
  tenant       uuid,
  subject_type text,
  subject_id   text,
  role         text,
  version_id   uuid                     DEFAULT NULL::uuid,
  expires_at   timestamp with time zone DEFAULT NULL::timestamp WITH time zone,
  max_uses     integer                  DEFAULT NULL::integer
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_id uuid;
  v_subject_ok boolean;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (auth.role() = 'service_role' or coalesce(better_supabase.can('tenant', create_share_link.tenant, 'quotes.update'), false)) then
    raise exception 'not allowed to share' using errcode = '42501', hint = 'SHARE_FORBIDDEN';
  end if;
  if create_share_link.expires_at is not null and create_share_link.expires_at <= now() then
    raise exception 'expires_at must be in the future' using errcode = '22023', hint = 'SHARE_EXPIRY_INVALID';
  end if;
  if create_share_link.max_uses is not null and create_share_link.max_uses < 1 then
    raise exception 'max_uses must be at least 1' using errcode = '22023', hint = 'SHARE_MAX_USES_INVALID';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'this subject type can''t be shared' using errcode = '22023', hint = 'SHARE_SUBJECT_UNKNOWN';
  end if;
  if create_share_link.version_id is not null then
    raise exception 'install the versions module to share a version' using errcode = '22023', hint = 'SHARE_VERSION_INVALID';
  end if;
  insert into "better_supabase"."share_links" ("tenant_id", "subject_type", "subject_id", "token_hash", "role", "expires_at", "max_uses", "created_by", "version_id")
  values (create_share_link.tenant, create_share_link.subject_type, create_share_link.subject_id, encode(extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex'), coalesce(create_share_link.role, 'view'), create_share_link.expires_at, create_share_link.max_uses, auth.uid(), create_share_link.version_id)
  returning "id" into v_id;
  null;
  return jsonb_build_object('id', v_id, 'token', v_token);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.current_tenant_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(
    (select m."organization_id"::text from "public"."organization_memberships" m where m."organization_id"::text = nullif(current_setting('better_supabase.tenant', true), '') and m."user_id" = auth.uid() limit 1),
    (select m."organization_id"::text from "public"."organization_memberships" m where m."organization_id"::text = nullif(current_setting('request.headers', true)::jsonb ->> 'x-bs-tenant', '') and m."user_id" = auth.uid() limit 1),
    (select m."organization_id"::text from "public"."organization_memberships" m where m."organization_id"::text = nullif(coalesce(auth.jwt() ->> 'tenant_id', auth.jwt() -> 'app_metadata' ->> 'tenant_id'), '') and m."user_id" = auth.uid() limit 1)
  )::uuid
$function$;

CREATE OR REPLACE FUNCTION better_supabase.has_organization_role (
  organization uuid,
  roles        text[] DEFAULT NULL::text[]
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select has_organization_role.organization in (
    select better_supabase.member_organization_ids(has_organization_role.roles)
  )
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_share_links (
  subject_type text,
  subject_id   text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', l."id", 'role', l."role", 'expiresAt', l."expires_at", 'revokedAt', l."revoked_at")), '[]'::jsonb)
  from "better_supabase"."share_links" l
  where l."subject_type" = list_share_links.subject_type
    and l."subject_id" = list_share_links.subject_id
    and (
      auth.role() = 'service_role'
      or l."created_by" = (select auth.uid())
      or l."tenant_id" in (select better_supabase.tenant_ids_with('quotes.read'))
    )
$function$;

CREATE OR REPLACE FUNCTION better_supabase.member_organization_ids (
  roles text[] DEFAULT NULL::text[]
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  ROWS 1
  SET search_path TO ''
  AS $function$
  select p.id
  from permdock.member_organization_ids() as p(id)
  where member_organization_ids.roles is null
    and not better_supabase.user_disabled((select auth.uid()))
    and not better_supabase.tenant_disabled(p.id)
  union
  select m."organization_id"
  from "public"."organization_memberships" m
  where member_organization_ids.roles is not null
    and m."user_id" = (select auth.uid())
    and m."role" = any (member_organization_ids.roles)
    and not better_supabase.user_disabled(m."user_id")
    and not better_supabase.tenant_disabled(m."organization_id")
    and m."organization_id" in (select p.id from permdock.member_organization_ids() as p(id))
$function$;

CREATE OR REPLACE FUNCTION better_supabase.membership_claims (
  user_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'scope', 'tenant',
      'id', m."organization_id",
      'roles', jsonb_build_array(m."role")
    ) order by m."created_at", m."organization_id"), '[]'::jsonb)
  from "public"."organization_memberships" m
  where m."user_id" = membership_claims.user_id
    and not better_supabase.user_disabled(membership_claims.user_id)
    and not better_supabase.tenant_disabled(m."organization_id")
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
    when 'share-links.create' then 'quotes.update'
    when 'share-links.read' then 'quotes.read'
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.organization_member_role (
  organization uuid,
  member       uuid
)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select m."role" from "public"."organization_memberships" m where m."organization_id" = organization_member_role.organization and m."user_id" = organization_member_role.member and m."organization_id" in (select p.id from permdock.member_organization_ids_for(organization_member_role.member) as p(id))
$function$;

CREATE OR REPLACE FUNCTION better_supabase.raise_actor_readonly()
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.record_view (
  tenant       uuid,
  subject_type text,
  subject_id   text,
  viewer_kind  text,
  viewer       text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (auth.role() = 'service_role' or record_view.tenant in (select better_supabase.member_organization_ids())) then
    raise exception 'not a member of this organization' using errcode = '42501', hint = 'SHARE_FORBIDDEN';
  end if;
  insert into "better_supabase"."subject_views" ("tenant_id", "subject_type", "subject_id", "viewer_kind", "viewer")
  values (record_view.tenant, record_view.subject_type, record_view.subject_id, record_view.viewer_kind, record_view.viewer)
  on conflict ("tenant_id", "subject_type", "subject_id", "viewer_kind", "viewer")
  do update set "last_viewed_at" = now(), "view_count" = "better_supabase"."subject_views"."view_count" + 1;
  null;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.resolve_share_link (
  token text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_link "better_supabase"."share_links"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_link
  from "better_supabase"."share_links" l
  where l."token_hash" = encode(extensions.digest(convert_to(resolve_share_link.token, 'utf8'), 'sha256'), 'hex')
    and l."revoked_at" is null
    and (l."expires_at" is null or l."expires_at" > now())
    and (l."max_uses" is null or l."use_count" < l."max_uses")
  for update;
  if not found then
    return null;
  end if;
  update "better_supabase"."share_links" set "use_count" = "use_count" + 1
  where "id" = v_link."id";
  return jsonb_build_object('id', v_link."id", 'organizationId', v_link."tenant_id", 'subjectType', v_link."subject_type", 'subjectId', v_link."subject_id", 'role', v_link."role", 'versionId', v_link."version_id", 'expiresAt', v_link."expires_at", 'maxUses', v_link."max_uses");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.revoke_share_link (
  id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_tenant uuid;
  v_creator uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select "tenant_id", "created_by" into v_tenant, v_creator
  from "better_supabase"."share_links"
  where "id" = revoke_share_link.id and "revoked_at" is null
  for update;
  if not found or not (
    auth.role() = 'service_role'
    or (v_creator is not null and v_creator = auth.uid())
    or coalesce(better_supabase.can('tenant', v_tenant, 'quotes.update'), false)
  ) then
    raise exception 'share link not found' using errcode = 'P0002', hint = 'SHARE_NOT_FOUND';
  end if;
  update "better_supabase"."share_links" set "revoked_at" = now()
  where "id" = revoke_share_link.id;
  null;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.set_user_state (
  subject_type text,
  subject_id   text,
  starred      boolean
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  insert into "better_supabase"."subject_user_state" ("subject_type", "subject_id", "user_id", "starred_at", "last_opened_at")
  values (set_user_state.subject_type, set_user_state.subject_id, auth.uid(), case when set_user_state.starred then now() else null end, now())
  on conflict ("subject_type", "subject_id", "user_id")
  do update set "starred_at" = excluded."starred_at", "last_opened_at" = now();
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_cancel (
  p_filter jsonb,
  p_by     text,
  p_note   text,
  p_now    text
)
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  with cancelled as (
    update "permdock".approval_requests a
    set status = 'rejected',
      body = (a.body - 'note') || jsonb_strip_nulls(jsonb_build_object(
        'status', 'rejected', 'resolvedAt', p_now, 'resolvedBy', 'system:' || p_by, 'note', p_note
      ))
    where a.status = 'pending'
      and (p_filter ->> 'status' is null or a.status = p_filter ->> 'status')
      and (p_filter ->> 'tenant' is null or a.tenant = p_filter ->> 'tenant')
      and (p_filter ->> 'principalId' is null or a.principal_id = p_filter ->> 'principalId')
      and (p_filter ->> 'actorId' is null or a.actor_id = p_filter ->> 'actorId')
      and (p_filter ->> 'session' is null or a.session = p_filter ->> 'session')
    returning 1
  )
  select count(*)::integer from cancelled
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_consume (
  p_token text,
  p_now   text
)
  RETURNS jsonb
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  update "permdock".approval_requests a
  set consumed_at = p_now::timestamptz,
    body = a.body || jsonb_build_object('consumedAt', p_now)
  where a.token = p_token
    and a.status = 'approved'
    and a.consumed_at is null
    and a.expires_at > p_now::timestamptz
  returning a.body
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_expire (
  p_now text
)
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  with expired as (
    update "permdock".approval_requests a
    set status = 'expired', body = a.body || '{"status":"expired"}'::jsonb
    where a.status = 'pending' and a.expires_at <= p_now::timestamptz
    returning 1
  )
  select count(*)::integer from expired
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_get (
  p_token text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.body from "permdock".approval_requests a where a.token = p_token
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_list (
  p_filter        jsonb,
  p_after_created text,
  p_after_token   text,
  p_limit         integer
)
  RETURNS SETOF jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a.body
  from "permdock".approval_requests a
  where (p_filter ->> 'status' is null or a.status = p_filter ->> 'status')
    and (p_filter ->> 'tenant' is null or a.tenant = p_filter ->> 'tenant')
    and (p_filter ->> 'principalId' is null or a.principal_id = p_filter ->> 'principalId')
    and (p_filter ->> 'actorId' is null or a.actor_id = p_filter ->> 'actorId')
    and (p_filter ->> 'session' is null or a.session = p_filter ->> 'session')
    and (p_after_created is null
      or (a.created_at collate "C", a.token collate "C") > (p_after_created collate "C", p_after_token collate "C"))
  order by a.created_at collate "C", a.token collate "C"
  limit p_limit
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_open (
  p_request jsonb
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  insert into "permdock".approval_requests as a (token, body, status, tenant, principal_id, actor_id, session, approvals, created_at, expires_at, consumed_at)
  values (
    p_request ->> 'token',
    p_request,
    p_request ->> 'status',
    p_request #>> '{subject,principal,tenant}',
    p_request #>> '{subject,principal,id}',
    p_request #>> '{subject,actor,id}',
    p_request #>> '{subject,session}',
    coalesce(jsonb_array_length(p_request -> 'approvals'), 0),
    p_request ->> 'createdAt',
    (p_request ->> 'expiresAt')::timestamptz,
    (p_request ->> 'consumedAt')::timestamptz
  )
  on conflict (token) do update
    set body = excluded.body, status = excluded.status, tenant = excluded.tenant,
      principal_id = excluded.principal_id, actor_id = excluded.actor_id, session = excluded.session,
      approvals = excluded.approvals, created_at = excluded.created_at,
      expires_at = excluded.expires_at, consumed_at = excluded.consumed_at
    where a.status = 'expired' or a.expires_at <= now()
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_resolve (
  p_token text,
  p_next  jsonb,
  p_seen  integer
)
  RETURNS jsonb
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  update "permdock".approval_requests a
  set body = p_next,
    status = p_next ->> 'status',
    approvals = coalesce(jsonb_array_length(p_next -> 'approvals'), 0)
  where a.token = p_token
    and a.status = 'pending'
    and a.expires_at > now()
    and a.approvals = p_seen
  returning a.body
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_capability_ids (
  p_resource   text,
  p_role       text,
  p_permission text
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select c -> 'on' ->> 'id'
  from (select ((select auth.jwt()) -> 'capability') as c) capability
  where jsonb_typeof(c) = 'object'
    and c ->> 'v' = '1'
    and c ->> 'holder' = 'link'
    and c -> 'on' ->> 'resource' = p_resource
    and jsonb_typeof(c -> 'roles') = 'array'
    and c -> 'roles' @> jsonb_build_array(p_role)
    and (c -> 'permissions' is null or c -> 'permissions' @> jsonb_build_array(p_permission))
    and jsonb_typeof(c -> 'expires_at') = 'number'
    and (c ->> 'expires_at')::numeric > extract(epoch from now())
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_cover_approves (
  p_delegator uuid,
  p_approvers jsonb,
  p_tenant    text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_item jsonb;
begin
  if p_delegator is null or p_approvers is null then
    return false;
  end if;
  if jsonb_typeof(p_approvers) = 'array' then
    if jsonb_array_length(p_approvers) = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_approvers) loop
      if not "permdock".permdock_cover_approves(p_delegator, v_item, p_tenant) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if jsonb_typeof(p_approvers) <> 'object' then
    return false;
  end if;
  case p_approvers ->> 'kind'
    when 'user' then
      return coalesce(p_approvers ->> 'id' = p_delegator::text, false);
    when 'permission' then
      if p_tenant is null then
        return coalesce("permdock".permdock_has_permission_for(p_delegator, p_approvers ->> 'permission'), false);
      end if;
      return exists (
          select 1
          from "permdock".permitted_organization_ids_by_permission_for(p_delegator, p_approvers ->> 'permission') i(id)
          where i.id::text = p_tenant
        );
    when 'any-of' then
      if jsonb_typeof(p_approvers -> 'of') <> 'array' then
        return false;
      end if;
      for v_item in select value from jsonb_array_elements(p_approvers -> 'of') loop
        if "permdock".permdock_cover_approves(p_delegator, v_item, p_tenant) then
          return true;
        end if;
      end loop;
      return false;
    else
      return false;
  end case;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_entries (
  p_scope   text,
  p_allow   text[],
  p_deny    text[],
  p_include text[]
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_entry text;
  v_key text;
  v_problem text;
begin
  foreach v_entry in array coalesce(p_allow, '{}'::text[]) loop
    v_key := v_entry;
    v_problem := "permdock".permdock_custom_role_entry_problem(p_scope, v_entry);
    if v_problem = 'unknown-permission' then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_entry || ' is not a declared permission',
        hint = 'unknown-permission';
    end if;
    if v_problem = 'outside-ceiling' then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_key || ' is outside the ceiling of ' || p_scope,
        hint = 'outside-ceiling';
    end if;
  end loop;
  foreach v_entry in array coalesce(p_deny, '{}'::text[]) loop
    if not (v_entry = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'staff.list', 'staff.read']::text[])) then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_entry || ' is not a declared permission',
        hint = 'unknown-permission';
    end if;
  end loop;
  foreach v_entry in array coalesce(p_include, '{}'::text[]) loop
    if not (v_entry = any(array['contact', 'guest', 'member', 'owner']::text[])) then
      raise exception using
        errcode = '22023',
        message = 'permdock: ' || v_entry || ' is not a declared role',
        hint = 'unknown-role';
    end if;
  end loop;
  select string_agg(distinct rp.permission, ', ') into v_key
  from "permdock".role_permissions rp
  where rp.role = any(coalesce(p_include, '{}'::text[]))
    and rp.effect = 'allow'
    and not exists (
      select 1 from "permdock".permdock_ceiling c
      where c.scope = p_scope and c.effect = 'allow' and c.permission = rp.permission
    );
  if v_key is not null then
    raise exception using
      errcode = '22023',
      message = 'permdock: an included role allows ' || v_key || ', outside the ceiling of ' || p_scope,
      hint = 'outside-ceiling';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_name_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if new."organization_id"::uuid is null or coalesce(new."is_system", false) then
    return new;
  end if;
  if new."key"::text = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || new."key"::text || ' is a declared role',
      hint = 'declared-role';
  end if;
  if "permdock".permdock_is_shared_role(case when new."organization_id"::uuid is null then 'global' else 'organization' end, new."key"::text) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || new."key"::text || ' is a shared role',
      hint = 'name-taken';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_shape (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  if p_scope = 'global' then
    if p_tenant is not null or p_scope_id is not null then
      raise exception using
        errcode = '22023',
        message = 'permdock: a platform custom role has no tenant or instance',
        hint = 'unknown-scope';
    end if;
  elsif not (p_scope = any(array['organization', 'customer']::text[])) then
    raise exception using
      errcode = '22023',
      message = 'permdock: custom roles are held at a scope of a tenant or at global, not ' || coalesce(p_scope, 'null'),
      hint = 'unknown-scope';
  elsif p_tenant is null and p_scope_id is not null then
    raise exception using
      errcode = '22023',
      message = 'permdock: a shared custom role has no instance',
      hint = 'unknown-scope';
  end if;
  if coalesce(p_role, '') = '' or p_role = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(p_role, 'null') || ' is not a custom role name',
      hint = 'declared-role';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has (
  p_grant text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select exists (
    select 1
    from "permdock".user_roles ur
    join "permdock".role_permissions rp on rp.role = ur.role::text
    where ur.user_id = (select "permdock".permdock_user_id())
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = (select "permdock".permdock_user_id())
      and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
      and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
      'global'
    ))
  )
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has_for (
  p_user  uuid,
  p_grant text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select exists (
    select 1
    from "permdock".user_roles ur
    join "permdock".role_permissions rp on rp.role = ur.role::text
    where ur.user_id = p_user
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = p_user
      and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
      and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
      'global'
    ))
  )
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_is_approver (
  p_approvers jsonb,
  p_tenant    text  DEFAULT NULL::text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_item jsonb;
  v_user text := (select "permdock".permdock_user_id())::text;
begin
  if coalesce(v_user, '') = '' or p_approvers is null then
    return false;
  end if;
  if jsonb_typeof(p_approvers) = 'array' then
    if jsonb_array_length(p_approvers) = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_approvers) loop
      if not "permdock".permdock_is_approver(v_item, p_tenant) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if jsonb_typeof(p_approvers) <> 'object' then
    return false;
  end if;
  case p_approvers ->> 'kind'
    when 'user' then
      return coalesce(p_approvers ->> 'id' = v_user, false);
    when 'permission' then
      if p_tenant is null then
        return coalesce("permdock".permdock_has_permission(p_approvers ->> 'permission'), false);
      end if;
      return exists (
          select 1
          from "permdock".permitted_organization_ids_by_permission(p_approvers ->> 'permission') i(id)
          where i.id::text = p_tenant
        );
    when 'any-of' then
      if jsonb_typeof(p_approvers -> 'of') <> 'array' then
        return false;
      end if;
      for v_item in select value from jsonb_array_elements(p_approvers -> 'of') loop
        if "permdock".permdock_is_approver(v_item, p_tenant) then
          return true;
        end if;
      end loop;
      return false;
    else
      return false;
  end case;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_is_approver (
  p_approvers jsonb,
  p_tenant    text,
  p_requester text,
  p_resource  text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_delegator uuid;
  v_user text := (select "permdock".permdock_user_id())::text;
begin
  if "permdock".permdock_is_approver(p_approvers, p_tenant) then
    return true;
  end if;
  if coalesce(v_user, '') = '' or coalesce(p_requester, '') = '' then
    return false;
  end if;
  if p_tenant is not null and not (p_tenant in (select m.id::text from "permdock".member_organization_ids() m(id))) then
    return false;
  end if;
  for v_delegator in
    select d.delegator
    from "permdock".approval_delegations d
    where d.delegate::text = v_user
      and d.delegator::text <> v_user
      and d.delegator::text <> p_requester
      and d."from" <= now()
      and now() < d."until"
      and (d.tenant is null or d.tenant = p_tenant)
      and d.permissions is null
      and (d.resources is null or p_resource = any (d.resources))
  loop
    if "permdock".permdock_cover_approves(v_delegator, p_approvers, p_tenant) then
      return true;
    end if;
  end loop;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_rename_custom_role_grants (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_from     text,
  p_to       text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform "permdock".permdock_custom_role_guard(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role',
      hint = 'name-taken';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name',
      hint = 'declared-role';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' already has grants',
      hint = 'role-exists';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_from;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_replace_custom_role_grants_by_id (
  p_role_id     uuid,
  p_permissions text[]
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
  v_scope text;
  v_scope_id text;
  v_key text;
  v_skipped boolean;
  v_deny text[];
  v_include text[];
begin
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'organization' end, null::text, r."key"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null'),
      hint = 'unknown-role';
  end if;
  if v_skipped or v_key = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role',
      hint = 'declared-role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key;
  perform "permdock".permdock_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "source" => 'permdock');
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_role_permissions (
  p_role     text,
  p_scope    text,
  p_tenant   uuid DEFAULT NULL::uuid,
  p_scope_id text DEFAULT NULL::text
)
  RETURNS TABLE (
    permission text,
    effect     text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if p_role = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    return query
  select distinct rp.permission, rp.effect
  from "permdock".role_permissions rp
  where rp.role = p_role and rp.scope = p_scope
  order by 1, 2;
    return;
  end if;
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '' and (
    false
    or (p_scope <> 'global' and p_tenant is null and p_scope_id is null)
    or (p_scope <> 'global' and (p_tenant::text in (select x::text from "permdock".member_organization_ids() x)
      or (case p_scope when 'organization' then false when 'customer' then p_scope_id in (select x::text from "permdock".member_customer_ids() x) else false end)))
  )) then
    raise exception using
      errcode = '42501',
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform'),
      hint = 'not-member';
  end if;
  return query
  select distinct rp.permission, rp.effect
  from "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role),
    p_scope
  ) k(grant_key)
  join "permdock".role_permissions rp on rp.grant_key = k.grant_key and rp.scope = p_scope
  order by 1, 2;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_rename_custom_role_grants (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_from     text,
  p_to       text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role',
      hint = 'name-taken';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name',
      hint = 'declared-role';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_to) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || p_to || ' already has grants',
      hint = 'role-exists';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_from;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_replace_custom_role_grants_by_id (
  p_role_id     uuid,
  p_permissions text[]
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
  v_scope text;
  v_scope_id text;
  v_key text;
  v_skipped boolean;
  v_deny text[];
  v_include text[];
begin
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'organization' end, null::text, r."key"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null'),
      hint = 'unknown-role';
  end if;
  if v_skipped or v_key = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role',
      hint = 'declared-role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key;
  perform "permdock".permdock_trusted_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "source" => 'permdock');
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_role_permissions (
  p_role     text,
  p_scope    text,
  p_tenant   uuid DEFAULT NULL::uuid,
  p_scope_id text DEFAULT NULL::text
)
  RETURNS TABLE (
    permission text,
    effect     text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if p_role = any(array['contact', 'guest', 'member', 'owner']::text[]) then
    return query
  select distinct rp.permission, rp.effect
  from "permdock".role_permissions rp
  where rp.role = p_role and rp.scope = p_scope
  order by 1, 2;
    return;
  end if;
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  return query
  select distinct rp.permission, rp.effect
  from "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id and c.role = p_role),
    p_scope
  ) k(grant_key)
  join "permdock".role_permissions rp on rp.grant_key = k.grant_key and rp.scope = p_scope
  order by 1, 2;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_role_permissions_by_id (
  p_role_ids text[],
  p_tenant   uuid   DEFAULT NULL::uuid
)
  RETURNS TABLE (
    role_id    text,
    permission text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if p_tenant is not null and exists (
    select 1 from "public"."roles" r
    where r."id"::text = any(p_role_ids) and r."organization_id"::uuid is distinct from p_tenant
  ) then
    raise exception using
      errcode = '42501',
      message = 'permdock: a role id belongs to another tenant than ' || p_tenant::text,
      hint = 'not-member';
  end if;
  return query
  select distinct v.role_id, c.permission
  from (
    select r."id"::text as role_id, r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'organization' end as scope, null::text as scope_id, r."key"::text as role
    from "public"."roles" r
    where r."id"::text = any(p_role_ids)
      and not (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
      and not (r."key"::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ) v
  join "permdock".custom_role_permissions c
    on c.tenant_id is not distinct from v.tenant_id
    and c.scope = v.scope
    and c.scope_id is not distinct from v.scope_id
    and c.role = v.role
  where c.effect = 'allow'
    and c.permission = any(array['audit.revert', 'audit.view', 'quotes.list', 'quotes.read', 'quotes.update', 'staff.list', 'staff.read']::text[])
  order by 1, 2;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
  v_user_1 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'customer'
    ));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_for (
  p_user  uuid,
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
  v_user_1 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and rp.scope = 'customer'
  union
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'customer'
    ));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys (
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
  v_user_1 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
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
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys (
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
  v_user_1 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
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
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys_for (
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
  v_user_1 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
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
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys_for (
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
  v_user_1 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    values
      ('quotes.list', 'customer', 'allow', 'quotes.list'),
      ('quotes.read', 'customer', 'allow', 'quotes.read')
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
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.scope = 'customer'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('customer', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.within ->> 'organization')::text end and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'customer'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'organization'
    ));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_for (
  p_user  uuid,
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := p_user;
begin
  return query
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
  union
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
    and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
      'organization'
    ));
end;
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
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
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
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
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
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
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
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
    'global'
  ) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.scope = 'organization'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where case when "permdock".permdock_is_shared_role('organization', r.role) then c.tenant_id is null else c.tenant_id::text = (ms.id)::text end and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role),
    'organization'
  ) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['contact', 'guest', 'member', 'owner']::text[]))
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

CREATE VIEW "permdock"."permdock_ceiling" WITH (security_invoker=true) AS  SELECT scope,
    role,
    permission,
    grant_key,
    effect
   FROM permdock.role_permissions rp
  WHERE ((role = ANY (ARRAY['guest'::text, 'member'::text, 'owner'::text])) AND (EXISTS ( SELECT 1
           FROM permdock.role_permissions a
          WHERE ((a.role = rp.role) AND (a.permission = rp.permission) AND (a.scope = rp.scope) AND (a.effect = 'allow'::text)))));

CREATE VIEW "public"."organization_memberships" WITH (security_invoker=true) AS  SELECT DISTINCT ON (scope_id, user_id) scope_id AS organization_id,
    user_id,
    role,
    created_at
   FROM public.memberships
  WHERE (scope = 'organization'::text)
  ORDER BY scope_id, user_id, created_at, role;

REVOKE ALL ON TABLE "public"."organization_memberships" FROM "anon", "authenticated";

CREATE INDEX share_links_subject_idx ON better_supabase.share_links USING btree (tenant_id, subject_type, subject_id);

CREATE INDEX approval_delegations_delegate ON permdock.approval_delegations USING btree (delegate, until);

CREATE INDEX approval_requests_page ON permdock.approval_requests USING btree (created_at COLLATE "C", token COLLATE "C");

CREATE INDEX approval_requests_pending ON permdock.approval_requests USING btree (status, expires_at);

CREATE POLICY "quotes_select_anon" ON "public"."quotes"
  FOR SELECT
  TO "anon"
  USING (((id)::text IN ( SELECT permdock.permdock_capability_ids('quotes'::text, 'guest'::text, 'quotes.read'::text) AS permdock_capability_ids)));

REVOKE ALL ON FUNCTION "better_supabase"."actor_may_write"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."actor_may_write"() TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."create_share_link"(uuid, text, text, text, uuid, timestamp WITH time zone, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."create_share_link"(uuid, text, text, text, uuid, timestamp WITH time zone, integer) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."current_tenant_id"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."current_tenant_id"() TO "anon", "authenticated", "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."has_organization_role"(uuid, text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."has_organization_role"(uuid, text[]) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_share_links"(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_share_links"(text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."member_organization_ids"(text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."member_organization_ids"(text[]) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."membership_claims"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."membership_claims"(uuid) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."organization_member_role"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."organization_member_role"(uuid, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."raise_actor_readonly"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."raise_actor_readonly"() TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."record_view"(uuid, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."record_view"(uuid, text, text, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."resolve_share_link"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."resolve_share_link"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."revoke_share_link"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."revoke_share_link"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."set_user_state"(text, text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."set_user_state"(text, text, boolean) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "permdock"."permdock_approval_cancel"(jsonb, text, text, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_approval_consume"(text, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_approval_expire"(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_approval_get"(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_approval_list"(jsonb, text, text, integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_approval_open"(jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_approval_resolve"(text, jsonb, integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_capability_ids"(text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_capability_ids"(text, text, text) TO "anon", "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permdock_cover_approves"(uuid, jsonb, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_is_approver"(jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_is_approver"(jsonb, text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permdock_is_approver"(jsonb, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_is_approver"(jsonb, text, text, text) TO "authenticated";

REVOKE ALL ON SCHEMA "permdock" FROM "anon";

GRANT USAGE ON SCHEMA "permdock" TO "anon";

GRANT SELECT ON TABLE "better_supabase"."share_links" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."share_links" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."subject_user_state" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."subject_user_state" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."subject_views" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."subject_views" TO "service_role";

GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE "permdock"."approval_delegations" TO "authenticated";

REVOKE ALL ON TABLE "public"."quotes" FROM "anon";

GRANT SELECT ON TABLE "public"."quotes" TO "anon";

REVOKE ALL ON TABLE "public"."organization_memberships" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."organization_memberships" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."organization_memberships" TO "service_role";

CREATE POLICY "approval_delegations_delete" ON "permdock"."approval_delegations"
  FOR DELETE
  TO "authenticated"
  USING (((delegator)::text = (( SELECT permdock.permdock_user_id() AS permdock_user_id))::text));

CREATE POLICY "approval_delegations_insert" ON "permdock"."approval_delegations"
  FOR INSERT
  TO "authenticated"
  WITH CHECK ((((delegator)::text = (( SELECT permdock.permdock_user_id() AS permdock_user_id))::text) AND ((tenant IS NULL) OR (tenant IN ( SELECT (m.id)::text AS id
   FROM permdock.member_organization_ids() m(id))))));

CREATE POLICY "approval_delegations_read" ON "permdock"."approval_delegations"
  FOR SELECT
  TO "authenticated"
  USING
    ((((delegator)::text = (( SELECT permdock.permdock_user_id() AS permdock_user_id))::text) OR ((delegate)::text = (( SELECT permdock.permdock_user_id() AS
    permdock_user_id))::text)));

CREATE POLICY "approval_delegations_update" ON "permdock"."approval_delegations"
  FOR UPDATE
  TO "authenticated"
  USING (((delegator)::text = (( SELECT permdock.permdock_user_id() AS permdock_user_id))::text))
  WITH CHECK ((((delegator)::text = (( SELECT permdock.permdock_user_id() AS permdock_user_id))::text) AND ((tenant IS NULL) OR (tenant IN ( SELECT (m.id)::text AS id
   FROM permdock.member_organization_ids() m(id))))));
