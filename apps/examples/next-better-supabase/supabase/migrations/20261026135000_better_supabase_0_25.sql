SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION better_supabase.audit (
  target          regclass,
  ignore          text[]       DEFAULT '{}'::text[],
  replace_trigger boolean      DEFAULT false,
  redact          text[]       DEFAULT '{}'::text[],
  category        text         DEFAULT NULL::text,
  event_prefix    text         DEFAULT NULL::text,
  target_type     text         DEFAULT NULL::text,
  tenant_column   text         DEFAULT NULL::text,
  label_column    text         DEFAULT NULL::text,
  tenant_path     text         DEFAULT NULL::text,
  tenant_function regprocedure DEFAULT NULL::regprocedure
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  keys text[];
  path_steps jsonb := '[]';
  path_column text;
  parts text[];
  cur_rel regclass := target;
  cur_col text;
  ref_rel regclass;
  ref_col text;
  segment text;
  seg_table text;
  seg_read text;
  base_settings jsonb;
begin
  if audit.tenant_path is not null then
    parts := regexp_split_to_array(btrim(audit.tenant_path), '\s*->\s*');
    if coalesce(array_length(parts, 1), 0) < 2 then
      raise exception 'tenant_path % needs a column and at least one table.column hop', audit.tenant_path;
    end if;
    path_column := parts[1];
    cur_col := path_column;
    for i in 2..array_length(parts, 1) loop
      segment := parts[i];
      seg_read := substring(segment from '[^.]+$');
      seg_table := substring(segment from '^(.*)\.[^.]+$');
      if seg_read is null or seg_table is null then
        raise exception 'tenant_path hop % must be table.column', segment;
      end if;
      select con.confrelid::regclass, a.attname::text into ref_rel, ref_col
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_attribute a on a.attrelid = con.confrelid and a.attnum = con.confkey[1]
      where con.contype = 'f' and con.conrelid = cur_rel and array_length(con.conkey, 1) = 1
        and con.conkey[1] = (
          select c.attnum from pg_catalog.pg_attribute c
          where c.attrelid = cur_rel and c.attname = cur_col and not c.attisdropped
        );
      if ref_rel is null then
        raise exception 'tenant_path: % has no foreign key on column %', cur_rel, cur_col;
      end if;
      if pg_catalog.to_regclass(case when position('.' in seg_table) > 0 then seg_table else (select n.nspname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where c.oid = audit.target) || '.' || seg_table end) is distinct from ref_rel then
        raise exception 'tenant_path: % does not reference %', cur_col, seg_table;
      end if;
      path_steps := path_steps || jsonb_build_array(jsonb_build_object('table', ref_rel::text, 'ref', ref_col, 'read', seg_read));
      cur_rel := ref_rel;
      cur_col := seg_read;
    end loop;
  end if;
  perform better_supabase.replace_equivalent_triggers(
    target, 'bsb_audit', 'audit', replace_trigger
  );
  select array_agg(c.attname::text order by k.ord) into keys
  from pg_catalog.pg_index i
  cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
  join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
  where i.indrelid = audit.target and i.indisprimary;
  delete from "better_supabase"."audited_tables" a where a."target" = audit.target;
  base_settings := jsonb_strip_nulls(jsonb_build_object(
    'ignore', to_jsonb(coalesce(audit.ignore, '{}')),
    'redact', to_jsonb(coalesce(audit.redact, '{}')),
    'key_columns', to_jsonb(keys),
    'category', audit.category,
    'event_prefix', audit.event_prefix,
    'target_type', audit.target_type,
    'tenant_column', audit.tenant_column,
    'label_column', audit.label_column,
    'tenant_path', case when audit.tenant_path is not null then jsonb_build_object('column', path_column, 'steps', path_steps) end,
    'tenant_function', audit.tenant_function::text
  ));
  execute format('drop trigger if exists bsb_audit on %s', target);
  execute format('drop trigger if exists bsb_audit_update on %s', target);
  if cardinality(coalesce(audit.ignore, '{}')) > 0 then
    execute format(
      'create trigger bsb_audit after insert or delete on %s for each row execute function better_supabase.audit_row_change(%L)',
      target, base_settings::text
    );
    execute format(
      'create trigger bsb_audit_update after update on %s for each row when ((to_jsonb(old) - %L::text[]) is distinct from (to_jsonb(new) - %L::text[])) execute function better_supabase.audit_row_change(%L)',
      target, audit.ignore, audit.ignore, base_settings::text
    );
  else
    execute format(
      'create trigger bsb_audit after insert or update or delete on %s for each row execute function better_supabase.audit_row_change(%L)',
      target, base_settings::text
    );
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_forget_dropped()
  RETURNS event_trigger
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  delete from "better_supabase"."audited_tables" a
  where a."target"::oid in (
    select d.objid from pg_catalog.pg_event_trigger_dropped_objects() d
    where d.object_type = 'table'
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_revert_source (
  entries text[]
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  found_entries jsonb;
begin
  if cardinality(audit_revert_source.entries) > 1000 then
    raise exception 'revert at most 1000 entries at once' using errcode = '22023', hint = 'AUDIT_REVERT_TOO_MANY';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l."id"::text,
      'table', to_regclass(quote_ident(split_part(l."table_name", '.', 1)) || '.' || quote_ident(split_part(l."table_name", '.', 2)))::text,
      'op', l."op",
      'old', l."old_record",
      'new', l."new_record",
      'changed', to_jsonb(l."changed"),
      'keys', to_jsonb(coalesce(
        (select a."key_columns" from "better_supabase"."audited_tables" a where a."target" = to_regclass(quote_ident(split_part(l."table_name", '.', 1)) || '.' || quote_ident(split_part(l."table_name", '.', 2)))),
        (select array_agg(att.attname::text order by k.ord)
         from pg_catalog.pg_index i
         cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_catalog.pg_attribute att on att.attrelid = i.indrelid and att.attnum = k.attnum
         where i.indrelid = to_regclass(quote_ident(split_part(l."table_name", '.', 1)) || '.' || quote_ident(split_part(l."table_name", '.', 2))) and i.indisprimary)
      ))
    ) order by l."occurred_at" desc, l."id" desc), '[]'::jsonb)
  into found_entries
  from "better_supabase"."audit_events" l
  
  where l."id"::text = any (audit_revert_source.entries)
    and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')
      or (l."organization_id" is not null and coalesce(better_supabase.member_can(auth.uid(), l."organization_id", 'audit.revert'), false)));
  if jsonb_array_length(found_entries) <> cardinality(array(select distinct e from unnest(audit_revert_source.entries) e)) then
    raise exception 'an entry is missing or not yours to revert' using errcode = 'P0002', hint = 'AUDIT_ENTRY_NOT_FOUND';
  end if;
  return found_entries;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_row_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  entry record;
  settings jsonb;
  entry_id "better_supabase"."audit_events"."id"%type;
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  row_data jsonb := coalesce(new_row, old_row);
  changed_columns text[];
  changed_values jsonb;
  row_tenant uuid;
  v_jwt jsonb := auth.jwt();
  v_headers jsonb := better_supabase.request_headers();
  path_value text;
  path_step jsonb;
begin
  if tg_nargs > 0 then
    settings := tg_argv[0]::jsonb;
    select array(select jsonb_array_elements_text(coalesce(settings -> 'ignore', '[]'))) as ignore,
      coalesce(
        nullif(array(select jsonb_array_elements_text(coalesce(settings -> 'key_columns', '[]'))), '{}'),
        (select array_agg(c.attname::text order by k.ord)
         from pg_catalog.pg_index i
         cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
         where i.indrelid = tg_relid and i.indisprimary),
        '{id}'
      ) as key_columns,
      array(select jsonb_array_elements_text(coalesce(settings -> 'redact', '[]'))) as redact,
      settings ->> 'category' as category, settings ->> 'event_prefix' as event_prefix,
      settings ->> 'target_type' as target_type, settings ->> 'tenant_column' as tenant_column,
      settings ->> 'label_column' as label_column,
      settings -> 'tenant_path' as tenant_path, settings ->> 'tenant_function' as tenant_function
    into entry;
  else
    select coalesce(a."ignore", '{}') as ignore, coalesce(a."key_columns", '{id}') as key_columns,
      coalesce(a."redact", '{}') as redact, a."category" as category,
      a."event_prefix" as event_prefix, a."target_type" as target_type,
      a."tenant_column" as tenant_column, a."label_column" as label_column,
      null::jsonb as tenant_path, null::text as tenant_function
    into entry
    from (select 1) one
    left join "better_supabase"."audited_tables" a on a."target" = tg_relid::regclass;
  end if;
  row_tenant := case when row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end;
  -- A child row without a tenant column: follow the foreign-key path
  -- registered through tenant_path, then the tenant function.
  if row_tenant is null and entry.tenant_path is not null then
    path_value := row_data ->> (entry.tenant_path ->> 'column');
    for path_step in select * from jsonb_array_elements(entry.tenant_path -> 'steps') loop
      exit when path_value is null;
      execute format('select %I::text from %s where %I::text = $1 limit 1',
        path_step ->> 'read', path_step ->> 'table', path_step ->> 'ref')
        into path_value using path_value;
    end loop;
    row_tenant := case when path_value ~* '^[0-9a-f-]{36}$' then (path_value)::uuid end;
  end if;
  if row_tenant is null and entry.tenant_function is not null then
    execute format('select %s($1)::text', (entry.tenant_function::regprocedure)::oid::regproc) into path_value using row_data;
    row_tenant := case when path_value ~* '^[0-9a-f-]{36}$' then (path_value)::uuid end;
  end if;
  old_row := old_row - entry.ignore;
  new_row := new_row - entry.ignore;
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into changed_columns
    from jsonb_each(new_row) n
    where n.value is distinct from old_row -> n.key;
    if changed_columns is null then
      return null;
    end if;
  end if;
  -- Redacted columns stay in changed, with their values masked.
  old_row := old_row || coalesce((select jsonb_object_agg(k, '"[redacted]"'::jsonb) from unnest(entry.redact) k where old_row ? k), '{}');
  new_row := new_row || coalesce((select jsonb_object_agg(k, '"[redacted]"'::jsonb) from unnest(entry.redact) k where new_row ? k), '{}');
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "organization_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "request_id", "correlation_id", "scope")
  values (
    tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    lower(tg_op),
    old_row,
    new_row,
    changed_columns,
    coalesce(auth.uid(), better_supabase.acting_member()),
    coalesce(v_jwt ->> 'role', current_user),
    row_tenant,
    case when v_jwt -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'sub')::uuid end,
    v_jwt -> 'act' ->> 'reason',
    case when v_jwt -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name),
    case
      when coalesce(v_jwt ->> 'role', '') = 'service_role' then 'service'
      when v_jwt -> 'act' ->> 'kind' = 'support' then 'support'
      when v_jwt -> 'act' is not null then 'impersonation'
      when v_jwt ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end,
    coalesce(v_jwt -> 'user_metadata' ->> 'full_name', v_jwt ->> 'email'),
    null,
    row_data ->> entry.label_column,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
  )
  returning "id" into entry_id;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_settings (
  target regclass
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(
    (select convert_from(substring(t.tgargs from 1 for position('\x00'::bytea in t.tgargs) - 1), 'utf8')::jsonb
     from pg_catalog.pg_trigger t
     where t.tgrelid = audit_settings.target and t.tgname = 'bsb_audit' and t.tgnargs > 0),
    (select jsonb_strip_nulls(jsonb_build_object(
       'ignore', to_jsonb(a."ignore"), 'redact', to_jsonb(a."redact"), 'key_columns', to_jsonb(a."key_columns"),
       'category', a."category", 'event_prefix', a."event_prefix", 'target_type', a."target_type",
       'tenant_column', a."tenant_column", 'label_column', a."label_column"))
     from "better_supabase"."audited_tables" a where a."target" = audit_settings.target)
  )
$function$;

CREATE OR REPLACE FUNCTION better_supabase.clear_tenant_claim()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  update auth.users u
  set raw_app_meta_data = u.raw_app_meta_data - 'tenant_id'
  where u.id = old."user_id"
    and u.raw_app_meta_data ->> 'tenant_id' = old."organization_id"::text;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.current_tenant_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select (select m."organization_id"::text from "public"."organization_memberships" m where m."organization_id"::text = nullif(coalesce(auth.jwt() ->> 'tenant_id', auth.jwt() -> 'app_metadata' ->> 'tenant_id'), '') and m."user_id" = auth.uid() limit 1)::uuid
$function$;

CREATE OR REPLACE FUNCTION better_supabase.unaudit (
  target regclass
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  execute format('drop trigger if exists bsb_audit on %s', target);
  execute format('drop trigger if exists bsb_audit_update on %s', target);
  delete from "better_supabase"."audited_tables" a where a."target" = unaudit.target;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.unaudit (
  target text
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  relation regclass := pg_catalog.to_regclass(unaudit.target);
begin
  if relation is not null then
    perform better_supabase.unaudit(relation);
  end if;
  delete from "better_supabase"."audited_tables" a
  where not exists (select 1 from pg_catalog.pg_class c where c.oid = a."target"::oid);
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
  v_user_0 "public"."organization_memberships"."user_id"%type := uid;
  v_user_1 "public"."contacts"."user_id"%type := uid;
  v_roles_user "permdock"."user_roles"."user_id"%type := uid;
  extra jsonb;
  ver bigint;
begin
  claims := claims - 'attrs' - 'datetime_preferences' - 'features';
  select coalesce(jsonb_agg(distinct r."role"::text order by r."role"::text) filter (where r."role"::text is not null), '[]'::jsonb)
    into held
    from "permdock"."user_roles" r
    where r."user_id" = v_roles_user;
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := claims -> 'app_metadata' ->> 'tenant_id';
  for item in
    select x.entry, x.tenant is not distinct from active as current
    from (
      select 0 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managed_by', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."organization_memberships" m
        where m."user_id" = v_user_0
        group by m."organization_id"
        having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
      ) s
      union all
      select 1 as ord,
        (case when s.scope = 'organization' then s.id else s.within ->> 'organization' end) as tenant,
        jsonb_strip_nulls(jsonb_build_object(
          'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
          'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
          'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
          'managed_by', s.managed_by, 'entitlements', s.seats
        )) as entry
      from (
        select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
        from "public"."contacts" m
        where m."user_id" = v_user_1
        group by m."customer_id", m."organization_id"
        having jsonb_build_array('contact') is not null
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

CREATE TRIGGER bsb_clear_tenant_claim
  AFTER DELETE ON public.organization_memberships
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.clear_tenant_claim();

REVOKE ALL ON FUNCTION "better_supabase"."clear_tenant_claim"() FROM PUBLIC;

