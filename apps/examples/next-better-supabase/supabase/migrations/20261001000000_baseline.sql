SET local check_function_bodies = off;

CREATE SCHEMA "better_supabase";

CREATE SCHEMA "permdock";

CREATE TABLE "better_supabase"."audit_log" (
  "id"                   bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "table_name"           text                     NOT NULL,
  "record_id"            text,
  "op"                   text                     NOT NULL,
  "old_record"           jsonb,
  "new_record"           jsonb,
  "changed"              text[],
  "actor_id"             uuid,
  "actor_role"           text,
  "org_id"               uuid,
  "at"                   timestamp with time zone NOT NULL DEFAULT now(),
  "impersonated_by"      uuid,
  "impersonation_reason" text,
  CONSTRAINT "audit_log_op_check" CHECK ((op = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text]))),
  CONSTRAINT "audit_log_pkey" PRIMARY KEY (id)
);

ALTER TABLE "better_supabase"."audit_log"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."audited_tables" (
  "target" regclass NOT NULL,
  "ignore" text[]   NOT NULL DEFAULT '{}'::text[],
  CONSTRAINT "audited_tables_pkey" PRIMARY KEY (target)
);

ALTER TABLE "better_supabase"."audited_tables"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "permdock"."permdock_authz_version" (
  "user_id" uuid   NOT NULL,
  "version" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "permdock_authz_version_pkey" PRIMARY KEY (user_id)
);

ALTER TABLE "permdock"."permdock_authz_version"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "permdock"."role_permissions" (
  "role"       text NOT NULL,
  "permission" text NOT NULL,
  "grant_key"  text NOT NULL,
  "scope"      text NOT NULL,
  "effect"     text NOT NULL DEFAULT 'allow'::text,
  CONSTRAINT "role_permissions_effect_check" CHECK ((effect = ANY (ARRAY['allow'::text, 'deny'::text]))),
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY (ROLE, grant_key, scope),
  CONSTRAINT "role_permissions_scope_check" CHECK ((scope ~ '^[a-z][a-z0-9_]*$'::text))
);

ALTER TABLE "permdock"."role_permissions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "permdock"."user_roles" (
  "user_id" uuid NOT NULL,
  "role"    text NOT NULL,
  CONSTRAINT "user_roles_pkey" PRIMARY KEY (user_id, ROLE)
);

ALTER TABLE "permdock"."user_roles"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."contacts" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid                     NOT NULL,
  "customer_id"     uuid                     NOT NULL,
  "user_id"         uuid,
  "name"            text                     NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "contacts_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."contacts"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."contacts" FROM "anon", "authenticated";

CREATE TABLE "public"."customers" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid                     NOT NULL,
  "name"            text                     NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "customers_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."customers"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."customers" FROM "anon", "authenticated";

CREATE TABLE "public"."datetime_preferences" (
  "user_id"     uuid                     NOT NULL,
  "timezone"    text                     NOT NULL,
  "week_start"  text                     NOT NULL,
  "date_format" text                     NOT NULL,
  "time_format" text                     NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "datetime_preferences_pkey" PRIMARY KEY (user_id),
  CONSTRAINT "datetime_preferences_time_format_check" CHECK ((time_format = ANY (ARRAY['12h'::text, '24h'::text]))),
  CONSTRAINT "datetime_preferences_week_start_check" CHECK ((week_start = ANY (ARRAY['monday'::text, 'sunday'::text])))
);

ALTER TABLE "public"."datetime_preferences"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."datetime_preferences" FROM "anon";

CREATE TABLE "public"."memberships" (
  "user_id"    uuid                     NOT NULL,
  "scope"      text                     NOT NULL,
  "scope_id"   uuid                     NOT NULL,
  "role"       text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "memberships_pkey" PRIMARY KEY (user_id, scope, scope_id, ROLE)
);

ALTER TABLE "public"."memberships"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."memberships" FROM "anon", "authenticated";

CREATE TABLE "public"."organization_features" (
  "organization_id" uuid                     NOT NULL,
  "feature"         text                     NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "organization_features_pkey" PRIMARY KEY (organization_id, feature)
);

ALTER TABLE "public"."organization_features"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."organization_features" FROM "anon", "authenticated";

CREATE TABLE "public"."organizations" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "slug"       text                     NOT NULL,
  "name"       text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "organizations_pkey" PRIMARY KEY (id),
  CONSTRAINT "organizations_slug_key" UNIQUE (slug)
);

ALTER TABLE "public"."organizations"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."quotes" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid                     NOT NULL,
  "customer_id"     uuid                     NOT NULL,
  "title"           text                     NOT NULL,
  "amount_minor"    bigint                   NOT NULL,
  "currency"        text                     NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "quotes_amount_minor_check" CHECK ((amount_minor >= 0)),
  CONSTRAINT "quotes_currency_check" CHECK ((currency ~ '^[A-Z]{3}$'::text)),
  CONSTRAINT "quotes_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."quotes"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."quotes" FROM "anon";

CREATE TABLE "public"."staff" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid                     NOT NULL,
  "user_id"         uuid                     NOT NULL,
  "name"            text                     NOT NULL,
  "title"           text                     NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "staff_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."staff"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."staff" FROM "anon";

CREATE OR REPLACE FUNCTION better_supabase.audit (
  target regclass,
  ignore text[]   DEFAULT '{}'::text[]
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  insert into better_supabase.audited_tables as a (target, ignore) values (audit.target, audit.ignore)
  on conflict on constraint audited_tables_pkey do update set ignore = excluded.ignore;
  execute format('drop trigger if exists bs_audit on %s', target);
  execute format(
    'create trigger bs_audit after insert or update or delete on %s for each row execute function better_supabase.audit_trigger()',
    target
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_trigger()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  ignored text[];
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  row_data jsonb := coalesce(new_row, old_row);
  changed_columns text[];
begin
  select a.ignore into ignored
  from better_supabase.audited_tables a
  where a.target = tg_relid::regclass;
  ignored := coalesce(ignored, '{}');
  old_row := old_row - ignored;
  new_row := new_row - ignored;
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into changed_columns
    from jsonb_each(new_row) n
    where n.value is distinct from old_row -> n.key;
    if changed_columns is null then
      return null;
    end if;
  end if;
  insert into better_supabase.audit_log
    (table_name, record_id, op, old_record, new_record, changed, actor_id, actor_role, org_id,
     impersonated_by, impersonation_reason)
  values (
    tg_table_schema || '.' || tg_table_name,
    row_data ->> 'id',
    lower(tg_op),
    old_row,
    new_row,
    changed_columns,
    auth.uid(),
    coalesce(auth.jwt() ->> 'role', current_user),
    case
      when row_data ->> 'organization_id' ~ '^[0-9a-f-]{36}$'
        then (row_data ->> 'organization_id')::uuid
    end,
    case
      when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$'
        then (auth.jwt() -> 'act' ->> 'sub')::uuid
    end,
    auth.jwt() -> 'act' ->> 'reason'
  );
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.purge_audit_log (
  older_than interval DEFAULT '1 year'::interval,
  batch      integer  DEFAULT 10000
)
  RETURNS integer
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  with purged as (
    delete from better_supabase.audit_log
    where id in (
      select l.id from better_supabase.audit_log l
      where l.at < now() - older_than
      order by l.id
      limit batch
    )
    returning 1
  )
  select count(*)::integer from purged
$function$;

CREATE OR REPLACE FUNCTION better_supabase.set_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  new := jsonb_populate_record(
    new,
    jsonb_build_object(coalesce(tg_argv[0], 'updated_at'), now())
  );
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.track_updated_at (
  target      regclass,
  column_name text     DEFAULT 'updated_at'::text
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  execute format('drop trigger if exists bs_updated_at on %s', target);
  execute format(
    'create trigger bs_updated_at before update on %s for each row execute function better_supabase.set_updated_at(%L)',
    target,
    column_name
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.unaudit (
  target regclass
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  execute format('drop trigger if exists bs_audit on %s', target);
  delete from better_supabase.audited_tables a where a.target = unaudit.target;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.custom_access_token_hook (
  event jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  claims jsonb := event -> 'claims';
  uid uuid := (event ->> 'user_id')::uuid;
  active text;
  held jsonb;
  kept jsonb := '[]'::jsonb;
  truncated boolean := false;
  in_active boolean := false;
  budget integer := 1024;
  used integer := 0;
  item record;
  v_user_0 "public"."memberships"."user_id"%type := uid;
  v_user_1 "public"."contacts"."user_id"%type := uid;
  v_roles_user "permdock"."user_roles"."user_id"%type := uid;
  extra jsonb;
  ver bigint;
begin
  claims := claims - 'attrs' - 'datetime_preferences' - 'features';
  select coalesce(jsonb_agg(distinct r."role"::text order by r."role"::text), '[]'::jsonb)
    into held
    from "permdock"."user_roles" r
    where r."user_id" = v_roles_user;
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := claims -> 'app_metadata' ->> 'active_organization';
  for item in
    select x.entry, x.tenant is not distinct from active as current
    from (
      select 0 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expiresAt', s.expires_at, 'grantedBy', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managedBy', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."memberships" m
        where m."user_id" = v_user_0
        group by m."scope"::text, m."scope_id"::text
      ) s
      union all
      select 1 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expiresAt', s.expires_at, 'grantedBy', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managedBy', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."contacts" m
        where m."user_id" = v_user_1
        group by m."customer_id", m."organization_id"
      ) s
    ) x
    order by (x.tenant is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
  loop
    if octet_length((kept || jsonb_build_array(item.entry))::text) + used > budget then
      truncated := true;
      exit;
    end if;
    kept := kept || jsonb_build_array(item.entry);
    in_active := in_active or (active is not null and item.current);
  end loop;
  claims := jsonb_set(claims, '{memberships}', kept);
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));
  end if;
  extra := "public"."datetime_preference_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{datetime_preferences}', extra);
  end if;
  extra := "public"."feature_claims"(uid);
  if extra is not null then
    claims := jsonb_set(claims, '{features}', extra);
  end if;
  select v.version into ver from "permdock"."permdock_authz_version" v where v.user_id = uid;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(coalesce(ver, 0)));
  return jsonb_set(event, '{claims}', claims);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_customer_ids()
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select auth.uid());
  v_user_1 "public"."contacts"."user_id"%type := (select auth.uid());
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
  ) ms
  where coalesce((select auth.uid())::text, '') <> ''
    and ms.scope = 'customer'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_customer_ids_for (
  p_user uuid
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
  select distinct (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
  ) ms
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_organization_ids()
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."memberships"."user_id"%type := (select auth.uid());
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
  ) ms
  where coalesce((select auth.uid())::text, '') <> ''
    and ms.scope = 'organization'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_organization_ids_for (
  p_user uuid
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
  select distinct (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
  ) ms
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_bump_authz_version()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  column_name text := tg_argv[0];
  affected text;
begin
  foreach affected in array array[
    case when tg_op <> 'INSERT' then to_jsonb(old) ->> column_name end,
    case when tg_op <> 'DELETE' then to_jsonb(new) ->> column_name end
  ] loop
    if affected is not null then
      insert into "permdock"."permdock_authz_version" as v (user_id, version) values (affected::uuid, 1)
      on conflict (user_id) do update set version = v.version + 1;
    end if;
  end loop;
  return null;
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
    where ur.user_id = (select auth.uid())
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )
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
  v_user_0 "public"."memberships"."user_id"%type := (select auth.uid());
  v_user_1 "public"."contacts"."user_id"%type := (select auth.uid());
begin
  return query
  select (ms.id)::uuid
  from (
    select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."memberships" m
    where m."user_id" = v_user_0
    group by m."scope"::text, m."scope_id"::text
    union all
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_1
    group by m."customer_id", m."organization_id"
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where coalesce((select auth.uid())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and rp.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''));
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
  v_user_0 "public"."memberships"."user_id"%type := (select auth.uid());
begin
  return query
  select (ms.id)::uuid
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
  where coalesce((select auth.uid())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''));
end;
$function$;

CREATE OR REPLACE FUNCTION public.datetime_preference_claims (
  p_user_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'timezone', p.timezone,
    'week_start', p.week_start,
    'date_format', p.date_format,
    'time_format', p.time_format
  )
  from public.datetime_preferences p
  where p.user_id = p_user_id
$function$;

REVOKE ALL ON FUNCTION "public"."datetime_preference_claims"(uuid) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.feature_claims (
  p_user_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_object_agg(f.organization_id::text, f.features)
  from (
    select organization_id, jsonb_agg(feature order by feature) as features
    from public.organization_features
    where organization_id in (select permdock.member_organization_ids_for(p_user_id))
    group by organization_id
  ) f
$function$;

REVOKE ALL ON FUNCTION "public"."feature_claims"(uuid) FROM PUBLIC, "anon", "authenticated";

ALTER TABLE "permdock"."permdock_authz_version"
  ADD CONSTRAINT "permdock_authz_version_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "permdock"."user_roles"
  ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."contacts"
  ADD CONSTRAINT "contacts_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."contacts"
  ADD CONSTRAINT "contacts_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE "public"."datetime_preferences"
  ADD CONSTRAINT "datetime_preferences_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."memberships"
  ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."contacts"
  ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE "public"."customers"
  ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE "public"."organization_features"
  ADD CONSTRAINT "organization_features_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE "public"."quotes"
  ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE "public"."quotes"
  ADD CONSTRAINT "quotes_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE "public"."staff"
  ADD CONSTRAINT "staff_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE "public"."staff"
  ADD CONSTRAINT "staff_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX audit_log_org_idx ON better_supabase.audit_log USING btree (org_id, at DESC);

CREATE INDEX audit_log_record_idx ON better_supabase.audit_log USING btree (table_name, record_id, at DESC);

CREATE INDEX contacts_customer_id_idx ON public.contacts USING btree (customer_id);

CREATE INDEX contacts_organization_id_idx ON public.contacts USING btree (organization_id);

CREATE INDEX customers_organization_id_idx ON public.customers USING btree (organization_id);

CREATE INDEX permdock_contacts_user_id_idx ON public.contacts USING btree (user_id);

CREATE INDEX permdock_memberships_user_id_idx ON public.memberships USING btree (user_id);

CREATE INDEX permdock_quotes_customer_id_idx ON public.quotes USING btree (customer_id);

CREATE INDEX permdock_quotes_organization_id_idx ON public.quotes USING btree (organization_id);

CREATE INDEX permdock_staff_organization_id_idx ON public.staff USING btree (organization_id);

CREATE INDEX staff_user_id_idx ON public.staff USING btree (user_id);

CREATE TRIGGER permdock_authz_version
  AFTER INSERT OR DELETE OR UPDATE ON permdock.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_trigger();

CREATE TRIGGER bs_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE TRIGGER permdock_authz_version
  AFTER INSERT OR DELETE OR UPDATE ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_trigger();

CREATE TRIGGER bs_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.datetime_preferences
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_trigger();

CREATE TRIGGER bs_updated_at
  BEFORE UPDATE ON public.datetime_preferences
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.memberships
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_trigger();

CREATE TRIGGER permdock_authz_version
  AFTER INSERT OR DELETE OR UPDATE ON public.memberships
  FOR EACH ROW
  EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.organization_features
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_trigger();

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_trigger();

CREATE TRIGGER bs_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_trigger();

CREATE TRIGGER bs_updated_at
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.staff
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_trigger();

CREATE TRIGGER bs_updated_at
  BEFORE UPDATE ON public.staff
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE POLICY "permdock_auth_admin_read_version" ON "permdock"."permdock_authz_version"
  FOR SELECT
  TO "supabase_auth_admin"
  USING (true);

CREATE POLICY "permdock_auth_admin_read_roles" ON "permdock"."user_roles"
  FOR SELECT
  TO "supabase_auth_admin"
  USING (true);

CREATE POLICY "permdock_auth_admin_read_memberships" ON "public"."contacts"
  FOR SELECT
  TO "supabase_auth_admin"
  USING (true);

CREATE POLICY "datetime_preferences_auth_admin_read" ON "public"."datetime_preferences"
  FOR SELECT
  TO "supabase_auth_admin"
  USING (true);

CREATE POLICY "datetime_preferences_own_read" ON "public"."datetime_preferences"
  FOR SELECT
  TO "authenticated"
  USING ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "permdock_auth_admin_read_memberships" ON "public"."memberships"
  FOR SELECT
  TO "supabase_auth_admin"
  USING (true);

CREATE POLICY "organization_features_auth_admin_read" ON "public"."organization_features"
  FOR SELECT
  TO "supabase_auth_admin"
  USING (true);

CREATE POLICY "organizations_public_read" ON "public"."organizations"
  FOR SELECT
  TO "anon", "authenticated"
  USING (true);

CREATE POLICY "quotes_select" ON "public"."quotes"
  FOR SELECT
  TO "authenticated"
  USING
    (((organization_id IN ( SELECT permdock.permitted_organization_ids('quotes.read'::text) AS permitted_organization_ids)) OR (customer_id IN ( SELECT
    permdock.permitted_customer_ids('quotes.read'::text) AS permitted_customer_ids)) OR
    ((organization_id IN ( SELECT permdock.permitted_organization_ids('quotes.list'::text) AS permitted_organization_ids)) OR (customer_id IN ( SELECT
    permdock.permitted_customer_ids('quotes.list'::text) AS permitted_customer_ids)))));

CREATE POLICY "staff_select" ON "public"."staff"
  FOR SELECT
  TO "authenticated"
  USING
    (((organization_id IN ( SELECT permdock.permitted_organization_ids('staff.read'::text) AS permitted_organization_ids)) OR (organization_id IN ( SELECT
    permdock.permitted_organization_ids('staff.list'::text) AS permitted_organization_ids))));

REVOKE ALL ON FUNCTION "better_supabase"."purge_audit_log"(interval, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."purge_audit_log"(interval, integer) TO "service_role";

REVOKE ALL ON FUNCTION "permdock"."custom_access_token_hook"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."custom_access_token_hook"(jsonb) TO "supabase_auth_admin";

REVOKE ALL ON FUNCTION "permdock"."member_customer_ids"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."member_customer_ids"() TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."member_customer_ids_for"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."member_customer_ids_for"(uuid) TO "supabase_auth_admin";

REVOKE ALL ON FUNCTION "permdock"."member_organization_ids"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."member_organization_ids"() TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."member_organization_ids_for"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."member_organization_ids_for"(uuid) TO "supabase_auth_admin";

REVOKE ALL ON FUNCTION "permdock"."permdock_bump_authz_version"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permdock_has"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_has"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_customer_ids"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_customer_ids"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_organization_ids"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_organization_ids"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "public"."datetime_preference_claims"(uuid) FROM "postgres";

GRANT EXECUTE ON FUNCTION "public"."datetime_preference_claims"(uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."datetime_preference_claims"(uuid) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "public"."feature_claims"(uuid) FROM "postgres";

GRANT EXECUTE ON FUNCTION "public"."feature_claims"(uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."feature_claims"(uuid) TO "service_role", "supabase_auth_admin";

GRANT USAGE ON SCHEMA "better_supabase" TO "anon", "authenticated", "service_role";

GRANT USAGE ON SCHEMA "permdock" TO "authenticated", "supabase_auth_admin";

REVOKE ALL ON SCHEMA "public" FROM "supabase_auth_admin";

GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";

GRANT SELECT ON TABLE "better_supabase"."audit_log" TO "service_role";

GRANT SELECT ON TABLE "permdock"."permdock_authz_version" TO "supabase_auth_admin";

GRANT SELECT ON TABLE "permdock"."user_roles" TO "supabase_auth_admin";

REVOKE ALL ON TABLE "public"."contacts" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."contacts" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."contacts" TO "service_role";

GRANT SELECT ON TABLE "public"."contacts" TO "supabase_auth_admin";

REVOKE ALL ON TABLE "public"."customers" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."customers" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."customers" TO "service_role";

REVOKE ALL ON TABLE "public"."datetime_preferences" FROM "authenticated";

GRANT SELECT ON TABLE "public"."datetime_preferences" TO "authenticated";

REVOKE ALL ON TABLE "public"."datetime_preferences" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."datetime_preferences" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."datetime_preferences" TO "service_role";

GRANT SELECT ON TABLE "public"."datetime_preferences" TO "supabase_auth_admin";

REVOKE ALL ON TABLE "public"."memberships" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."memberships" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."memberships" TO "service_role";

GRANT SELECT ON TABLE "public"."memberships" TO "supabase_auth_admin";

REVOKE ALL ON TABLE "public"."organization_features" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."organization_features" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."organization_features" TO "service_role";

GRANT SELECT ON TABLE "public"."organization_features" TO "supabase_auth_admin";

REVOKE ALL ON TABLE "public"."organizations" FROM "anon";

GRANT SELECT ON TABLE "public"."organizations" TO "anon";

REVOKE ALL ON TABLE "public"."organizations" FROM "authenticated";

GRANT SELECT ON TABLE "public"."organizations" TO "authenticated";

REVOKE ALL ON TABLE "public"."organizations" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."organizations" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."organizations" TO "service_role";

REVOKE ALL ON TABLE "public"."quotes" FROM "authenticated";

GRANT SELECT ON TABLE "public"."quotes" TO "authenticated";

REVOKE ALL ON TABLE "public"."quotes" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."quotes" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."quotes" TO "service_role";

REVOKE ALL ON TABLE "public"."staff" FROM "authenticated";

GRANT SELECT ON TABLE "public"."staff" TO "authenticated";

REVOKE ALL ON TABLE "public"."staff" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."staff" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."staff" TO "service_role";
