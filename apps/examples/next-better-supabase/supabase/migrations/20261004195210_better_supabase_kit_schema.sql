SET local check_function_bodies = off;

REVOKE ALL ON SEQUENCE "better_supabase"."audit_log_id_seq" FROM "postgres";

ALTER TABLE "better_supabase"."audit_events"
  DROP CONSTRAINT "audit_log_op_check";

ALTER TABLE "better_supabase"."audit_events"
  DROP CONSTRAINT "audit_log_pkey";

DROP FUNCTION "better_supabase"."audit"(regclass, text[]);

DROP FUNCTION "better_supabase"."track_updated_at"(regclass, text);

ALTER SEQUENCE "better_supabase"."audit_log_id_seq" RENAME TO "audit_events_id_seq";

CREATE TABLE "better_supabase"."kit_modules" (
  "name"         text                     NOT NULL,
  "version"      integer                  NOT NULL,
  "mode"         text                     NOT NULL,
  "installed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "kit_modules_pkey" PRIMARY KEY (name)
);

ALTER TABLE "better_supabase"."kit_modules"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "support_session_id" uuid;

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "event_type" text;

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "category" text;

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "outcome" text;

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "source" text;

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "target_type" text;

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "metadata" jsonb;

ALTER TABLE "better_supabase"."audit_events"
  ADD COLUMN "idempotency_key" text;

ALTER TABLE "better_supabase"."audited_tables"
  ADD COLUMN "key_columns" text[] NOT NULL DEFAULT '{id}'::text[];

ALTER TABLE "better_supabase"."audited_tables"
  ADD COLUMN "redact" text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE "better_supabase"."audited_tables"
  ADD COLUMN "category" text;

ALTER TABLE "better_supabase"."audited_tables"
  ADD COLUMN "event_prefix" text;

ALTER TABLE "better_supabase"."audited_tables"
  ADD COLUMN "target_type" text;

ALTER TABLE "better_supabase"."audited_tables"
  ADD COLUMN "tenant_column" text;

ALTER TABLE "better_supabase"."audit_events"
  ALTER COLUMN "table_name" DROP NOT NULL;

CREATE OR REPLACE FUNCTION better_supabase.audit (
  target          regclass,
  ignore          text[]   DEFAULT '{}'::text[],
  replace_trigger boolean  DEFAULT false,
  redact          text[]   DEFAULT '{}'::text[],
  category        text     DEFAULT NULL::text,
  event_prefix    text     DEFAULT NULL::text,
  target_type     text     DEFAULT NULL::text,
  tenant_column   text     DEFAULT NULL::text
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  keys text[];
begin
  perform better_supabase.replace_equivalent_triggers(
    target, 'bs_audit', 'audit', replace_trigger
  );
  select array_agg(c.attname::text order by k.ord) into keys
  from pg_catalog.pg_index i
  cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
  join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
  where i.indrelid = audit.target and i.indisprimary;
  insert into better_supabase.audited_tables as a
    (target, ignore, key_columns, redact, category, event_prefix, target_type, tenant_column)
  values (
    audit.target, audit.ignore, coalesce(keys, '{id}'), audit.redact, audit.category,
    audit.event_prefix, audit.target_type, audit.tenant_column
  )
  on conflict on constraint audited_tables_pkey do update
    set ignore = excluded.ignore, key_columns = excluded.key_columns, redact = excluded.redact,
      category = excluded.category, event_prefix = excluded.event_prefix,
      target_type = excluded.target_type, tenant_column = excluded.tenant_column;
  execute format('drop trigger if exists bs_audit on %s', target);
  execute format(
    'create trigger bs_audit after insert or update or delete on %s for each row execute function better_supabase.audit_row_change()',
    target
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_append_only()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if tg_op = 'DELETE'
    and current_setting('better_supabase.audit_purge', true) = 'on'
    and current_user = (
      select r.rolname from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where p.oid = to_regprocedure('better_supabase.purge_audit_log(interval, integer, uuid, boolean)')
    )
  then
    return old;
  end if;
  raise exception 'audit log entries are append-only'
    using errcode = '42501', hint = 'Delete old entries with better_supabase.purge_audit_log()';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event (
  event_type      text,
  category        text  DEFAULT NULL::text,
  outcome         text  DEFAULT 'success'::text,
  source          text  DEFAULT NULL::text,
  target_type     text  DEFAULT NULL::text,
  record_id       text  DEFAULT NULL::text,
  tenant          uuid  DEFAULT NULL::uuid,
  metadata        jsonb DEFAULT '{}'::jsonb,
  idempotency_key text  DEFAULT NULL::text,
  restricted      jsonb DEFAULT NULL::jsonb,
  actor_id        uuid  DEFAULT NULL::uuid
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  existing text;
  entry_id "better_supabase"."audit_events"."id"%type;
begin
  if not (coalesce(nullif(auth.jwt() ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) or actor_id is null then
    actor_id := auth.uid();
  end if;
  if idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('better_supabase.audit_event'), pg_catalog.hashtext(coalesce(tenant::text, '') || ':' || idempotency_key));
    select l."id"::text into existing
    from "better_supabase"."audit_events" l
    where l."idempotency_key" = audit_event.idempotency_key
      and l."organization_id" is not distinct from audit_event.tenant
    limit 1;
    if existing is not null then
      return existing;
    end if;
  end if;
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "organization_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key")
  values (
    null,
    record_id,
    'event',
    actor_id,
    coalesce(auth.jwt() ->> 'role', current_user),
    tenant,
    case when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'sub')::uuid end,
    auth.jwt() -> 'act' ->> 'reason',
    case when auth.jwt() -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'session_id')::uuid end,
    event_type,
    coalesce(category, 'system'),
    coalesce(outcome, 'success'),
    coalesce(source, 'app'),
    target_type,
    coalesce(metadata, '{}'),
    idempotency_key
  )
  returning "id" into entry_id;
  return entry_id::text;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_events_tenants (
  older_than interval DEFAULT '1 day'::interval
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select distinct l."organization_id" from "better_supabase"."audit_events" l
  where l."occurred_at" < now() - older_than
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_row_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  entry record;
  entry_id "better_supabase"."audit_events"."id"%type;
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  row_data jsonb := coalesce(new_row, old_row);
  changed_columns text[];
begin
  select coalesce(a.ignore, '{}') as ignore, coalesce(a.key_columns, '{id}') as key_columns,
    coalesce(a.redact, '{}') as redact, a.category, a.event_prefix, a.target_type, a.tenant_column
  into entry
  from (select 1) one
  left join better_supabase.audited_tables a on a.target = tg_relid::regclass;
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
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "organization_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type")
  values (
    tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    lower(tg_op),
    old_row,
    new_row,
    changed_columns,
    auth.uid(),
    coalesce(auth.jwt() ->> 'role', current_user),
    case when row_data ->> coalesce(entry.tenant_column, 'organization_id') ~ '^[0-9a-f-]{36}$' then (row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end,
    case when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'sub')::uuid end,
    auth.jwt() -> 'act' ->> 'reason',
    case when auth.jwt() -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name)
  )
  returning "id" into entry_id;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.purge_audit_log (
  older_than interval DEFAULT '1 year'::interval,
  batch      integer  DEFAULT 10000,
  tenant     uuid     DEFAULT NULL::uuid,
  for_tenant boolean  DEFAULT false
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  purged integer;
begin
  perform set_config('better_supabase.audit_purge', 'on', true);
  if not for_tenant and to_regprocedure('"public"."audit_retention"(uuid)') is not null then
    with gone as (
      delete from "better_supabase"."audit_events"
      where "id" in (
        select l."id" from "better_supabase"."audit_events" l
        where l."occurred_at" < now() - coalesce("public"."audit_retention"(l."organization_id"), older_than)
        order by l."occurred_at"
        limit batch
      )
      returning 1
    )
    select count(*)::integer into purged from gone;
  else
    with gone as (
      delete from "better_supabase"."audit_events"
      where "id" in (
        select l."id" from "better_supabase"."audit_events" l
        where l."occurred_at" < now() - older_than
          and (not for_tenant or l."organization_id" is not distinct from purge_audit_log.tenant)
        order by l."occurred_at"
        limit batch
      )
      returning 1
    )
    select count(*)::integer into purged from gone;
  end if;
  perform set_config('better_supabase.audit_purge', 'off', true);
  return purged;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.replace_equivalent_triggers (
  target          regclass,
  kit_trigger     text,
  pattern         text,
  replace_trigger boolean
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  found record;
begin
  for found in
    select t.tgname as name, p.proname as fn
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = replace_equivalent_triggers.target
      and not t.tgisinternal
      and t.tgname <> replace_equivalent_triggers.kit_trigger
      and p.proname ~* replace_equivalent_triggers.pattern
  loop
    if replace_trigger then
      execute format('drop trigger %I on %s', found.name, target);
    else
      raise warning '% already has trigger % (%), which does what % does. Pass replace_trigger => true to drop it.',
        target, found.name, found.fn, kit_trigger;
    end if;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.request_ip()
  RETURNS inet
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  return nullif(trim(reverse(split_part(reverse(current_setting('request.headers', true)::json ->> 'x-forwarded-for'), ',', 1))), '')::inet;
exception when others then
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.track_updated_at (
  target          regclass,
  column_name     text     DEFAULT 'updated_at'::text,
  replace_trigger boolean  DEFAULT false
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  perform better_supabase.replace_equivalent_triggers(
    target, 'bs_updated_at', 'updated_at|moddatetime|touch', replace_trigger
  );
  execute format('drop trigger if exists bs_updated_at on %s', target);
  execute format(
    'create trigger bs_updated_at before update on %s for each row execute function better_supabase.set_updated_at(%L)',
    target,
    column_name
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.audit_retention (
  tenant uuid
)
  RETURNS interval
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select null::interval
$function$;

REVOKE ALL ON FUNCTION "public"."audit_retention"(uuid) FROM PUBLIC, "anon", "authenticated";

ALTER TABLE "better_supabase"."audit_events"
  ADD CONSTRAINT "audit_events_pkey" PRIMARY KEY (id);

ALTER TABLE "better_supabase"."audit_events"
  ADD CONSTRAINT "bs_audit_op_check" CHECK ((op = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text, 'event'::text])));

CREATE VIEW "better_supabase"."audit_log" WITH (security_invoker=true) AS  SELECT id,
    table_name,
    record_id,
    op,
    old_record,
    new_record,
    changed,
    actor_id,
    actor_role,
    organization_id,
    occurred_at,
    impersonated_by,
    impersonation_reason,
    support_session_id,
    event_type,
    category,
    outcome,
    source,
    target_type,
    metadata,
    idempotency_key,
    occurred_at AS at,
    organization_id AS org_id
   FROM better_supabase.audit_events l;

CREATE UNIQUE INDEX audit_events_idempotency_idx ON better_supabase.audit_events USING btree (idempotency_key, organization_id) NULLS NOT DISTINCT
  WHERE (idempotency_key IS NOT NULL);

CREATE INDEX audit_events_occurred_at_idx ON better_supabase.audit_events USING btree (occurred_at);

CREATE TRIGGER bs_audit_append_only
  BEFORE DELETE OR UPDATE ON better_supabase.audit_events
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_append_only();

CREATE TRIGGER bs_audit_no_truncate
  BEFORE TRUNCATE ON better_supabase.audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION better_supabase.audit_append_only();

COMMENT ON VIEW "better_supabase"."audit_log" IS 'deprecated: use better_supabase.audit_events';

REVOKE ALL ON FUNCTION "better_supabase"."audit"(regclass, text[], boolean, text[], text, text, text, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."audit_append_only"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."audit_event"(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."audit_event"(text, text, text, text, text, text, uuid, jsonb, text, jsonb, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."audit_events_tenants"(interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."audit_events_tenants"(interval) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."purge_audit_log"(interval, integer, uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."purge_audit_log"(interval, integer, uuid, boolean) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."replace_equivalent_triggers"(regclass, text, text, boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."track_updated_at"(regclass, text, boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."unaudit"(regclass) FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."audit_retention"(uuid) FROM "postgres";

GRANT EXECUTE ON FUNCTION "public"."audit_retention"(uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."audit_retention"(uuid) TO "service_role";

REVOKE ALL ON SEQUENCE "better_supabase"."audit_events_id_seq" FROM "postgres";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "better_supabase"."audit_events_id_seq" TO "postgres";

GRANT SELECT ON TABLE "better_supabase"."kit_modules" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."audit_log" TO "service_role";
