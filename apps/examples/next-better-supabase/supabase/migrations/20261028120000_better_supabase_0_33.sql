SET LOCAL search_path = pg_catalog;
SET LOCAL check_function_bodies = off;
ALTER TABLE "better_supabase"."share_links" ADD COLUMN "last_used_at" timestamp with time zone;
CREATE OR REPLACE FUNCTION better_supabase.create_share_link(tenant uuid, subject_type text, subject_id text, role text, version_id uuid DEFAULT NULL::uuid, expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_uses integer DEFAULT NULL::integer)
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
CREATE OR REPLACE FUNCTION better_supabase.member_permissions(member uuid, tenant uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when member is not null
      and not better_supabase.user_disabled(member)
      and not better_supabase.tenant_disabled(tenant)
    then coalesce(array(select k from unnest(coalesce((array(select permdock.permitted_organization_permission_keys_for(member, tenant))), '{}'::text[])) as k where k = any(array['audit.read', 'audit.revert', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[])), '{}'::text[])
    else '{}'::text[]
  end
$function$;
CREATE OR REPLACE FUNCTION better_supabase.operation_permission(op text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case op
    when 'audit.revert' then 'audit.revert'
    when 'audit.view' then 'audit.read'
    when 'audit.viewAll' then 'audit.read'
    when 'permissions.listRoles' then 'members.read'
    when 'permissions.setOverride' then 'roles.manage'
    when 'share-links.create' then 'quotes.update'
    when 'share-links.read' then 'quotes.read'
  end
$function$;
CREATE OR REPLACE FUNCTION better_supabase.permission_claims(user_id uuid, tenant uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when permission_claims.tenant is null then '{}'::jsonb
    else coalesce(jsonb_strip_nulls(jsonb_build_object(permission_claims.tenant::text, to_jsonb(better_supabase.member_permissions(permission_claims.user_id, permission_claims.tenant)))), '{}'::jsonb)
  end
$function$;
CREATE OR REPLACE FUNCTION better_supabase.resolve_share_link(token text)
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
  update "better_supabase"."share_links" set "use_count" = "use_count" + 1, "last_used_at" = now() where "id" = v_link."id";
  return jsonb_build_object('id', v_link."id", 'organizationId', v_link."tenant_id", 'subjectType', v_link."subject_type", 'subjectId', v_link."subject_id", 'role', v_link."role", 'versionId', v_link."version_id", 'expiresAt', v_link."expires_at", 'maxUses', v_link."max_uses");
end;
$function$;
CREATE OR REPLACE FUNCTION better_supabase.revoke_share_link(id uuid)
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
    or (v_creator is not null and coalesce(v_creator = auth.uid(), false))
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
REVOKE ALL ON FUNCTION "better_supabase"."permission_claims"(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "better_supabase"."permission_claims"(uuid, uuid) TO "service_role", "supabase_auth_admin";
