-- better-supabase module: prelude
-- @bsb-block prelude@1 managed
-- @bsb-hash sha256:28a8e16f06211a804977393841b1bf06012bc7facc35d095c7db66bf2532d775
-- The schema, the blocks table and the helper functions every block calls, each defined once.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create schema if not exists better_supabase;
grant usage on schema better_supabase to anon, authenticated, service_role;

create table better_supabase.blocks (
  name text primary key,
  block text,
  version integer not null,
  mode text not null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table better_supabase.blocks enable row level security;
revoke all on better_supabase.blocks from public, anon, authenticated;
grant select on better_supabase.blocks to service_role;

-- The user a service caller acts for, from the x-bsb-actor header. Null for
-- every other caller, so the header cannot be spoofed with a user's token.
-- Only service_role may call it; the security definer functions and triggers
-- that record an actor call it as their owner.
create or replace function better_supabase.acting_member()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  header text;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    return null;
  end if;
  header := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-bsb-actor';
  return case when header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then header::uuid end;
exception when others then
  return null;
end;
$$;
revoke execute on function better_supabase.acting_member() from public, anon, authenticated;
grant execute on function better_supabase.acting_member() to service_role;

create or replace function better_supabase.actor_may_write()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
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
$$;
revoke execute on function better_supabase.actor_may_write() from public;
grant execute on function better_supabase.actor_may_write() to anon, authenticated, service_role;

create or replace function better_supabase.raise_actor_readonly()
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
end;
$$;
revoke execute on function better_supabase.raise_actor_readonly() from public;
grant execute on function better_supabase.raise_actor_readonly() to anon, authenticated, service_role;

create or replace function better_supabase.as_column_type(value text, target anyelement)
returns anyelement
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  return value;
end;
$$;
revoke execute on function better_supabase.as_column_type(text, anyelement) from public;
grant execute on function better_supabase.as_column_type(text, anyelement) to anon, authenticated, service_role;

create or replace function better_supabase.try_column_type(value text, target anyelement)
returns anyelement
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  result alias for $0;
begin
  result := value;
  return result;
exception when data_exception or check_violation then
  return null;
end;
$$;
revoke execute on function better_supabase.try_column_type(text, anyelement) from public;
grant execute on function better_supabase.try_column_type(text, anyelement) to anon, authenticated, service_role;

create or replace function better_supabase.value_unsupported(label text)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  raise exception 'the app does not support the value %', label
    using errcode = '22023', hint = 'VALUE_UNSUPPORTED';
end;
$$;
revoke execute on function better_supabase.value_unsupported(text) from public;
grant execute on function better_supabase.value_unsupported(text) to anon, authenticated, service_role;

create or replace function better_supabase.column_default(relation text, name text, target anyelement)
returns anyelement
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  result alias for $0;
  v_default text;
begin
  select pg_catalog.pg_get_expr(d.adbin, d.adrelid) into v_default
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = pg_catalog.to_regclass(column_default.relation) and a.attname = column_default.name and not a.attisdropped;
  if v_default is not null then
    execute 'select ' || v_default into result;
  end if;
  return result;
end;
$$;
revoke execute on function better_supabase.column_default(text, text, anyelement) from public, anon, authenticated, service_role;

create or replace function better_supabase.import_run()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when nullif(current_setting('better_supabase.import_run', true), '') is not null and coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')
    then nullif(current_setting('better_supabase.import_run', true), '')::uuid
  end;
$$;
revoke execute on function better_supabase.import_run() from public;
grant execute on function better_supabase.import_run() to anon, authenticated, service_role;

-- True while the transaction runs in import mode, for an app trigger or
-- function that skips a side effect during an import: `if not
-- better_supabase.importing() then ... end if;`. Only the service role can
-- begin an import session, so a user session always gets false.
create or replace function better_supabase.importing()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select better_supabase.import_run() is not null;
$$;
revoke execute on function better_supabase.importing() from public;
grant execute on function better_supabase.importing() to anon, authenticated, service_role;

-- Moves every installed module's rows from record drop to record keep of the
-- subject table subject_table (schema.table): comments, attachments, tags and
-- the rest. Each module marks its handler with a comment, so this finds them
-- without naming them.
create or replace function better_supabase.merge_subject_refs(subject_table text, keep text, drop text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fn regproc;
begin
  for v_fn in
    select p.oid::regproc
    from pg_catalog.pg_proc p
    join pg_catalog.pg_description d on d.objoid = p.oid and d.classoid = 'pg_catalog.pg_proc'::regclass and d.objsubid = 0
    where d.description = 'better-supabase:subject-merge'
      -- Only the owner's functions, so a marked function in a schema another
      -- role can write to never runs with this function's rights.
      and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
    order by p.oid::regproc::text
  loop
    execute format('select %s($1, $2, $3)', v_fn) using subject_table, keep, drop;
  end loop;
end;
$$;
revoke execute on function better_supabase.merge_subject_refs(text, text, text) from public, anon, authenticated;

create or replace function better_supabase.memo_get(key text)
returns text
language sql
volatile
set search_path = ''
as $$
  select nullif(pg_catalog.current_setting('better_supabase.memo.' || key, true), '')
$$;

create or replace function better_supabase.memo_set(key text, value text)
returns text
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.set_config('better_supabase.memo.' || key, value, true)
$$;

create or replace function better_supabase.memo_slot_get(key text)
returns text
language sql
volatile
set search_path = ''
as $$
  select case when pg_catalog.split_part(v.slot, pg_catalog.chr(31), 1) = key
    then nullif(pg_catalog.substr(v.slot, pg_catalog.length(key) + 2), '') end
  from (select pg_catalog.current_setting('better_supabase.memo.s' || (pg_catalog.hashtext(key) & 255)::text, true) as slot) v
$$;

create or replace function better_supabase.memo_slot_set(key text, value text)
returns text
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.set_config('better_supabase.memo.s' || (pg_catalog.hashtext(key) & 255)::text, key || pg_catalog.chr(31) || coalesce(value, ''), true)
$$;

create or replace function better_supabase.replace_equivalent_triggers(
  target regclass,
  module_trigger text,
  pattern text,
  replace_trigger boolean
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  found record;
begin
  for found in
    select t.tgname as name, p.proname as fn
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = replace_equivalent_triggers.target
      and not t.tgisinternal
      and t.tgname <> replace_equivalent_triggers.module_trigger
      and p.proname ~* replace_equivalent_triggers.pattern
  loop
    if replace_trigger then
      execute format('drop trigger %I on %s', found.name, target);
    else
      raise warning '% already has trigger % (%), which does what % does. Pass replace_trigger => true to drop it.',
        target, found.name, found.fn, module_trigger;
    end if;
  end loop;
end;
$$;
revoke execute on function better_supabase.replace_equivalent_triggers(regclass, text, text, boolean) from public, anon, authenticated;

create or replace function better_supabase.validate_iban(value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  compact text;
  moved text;
  rest integer := 0;
  i integer;
  piece text;
  j integer;
begin
  compact := upper(regexp_replace(coalesce(value, ''), '\s', '', 'g'));
  if compact !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then
    return false;
  end if;
  moved := substring(compact from 5) || substring(compact from 1 for 4);
  for i in 1 .. char_length(moved) loop
    piece := case
      when substring(moved from i for 1) between 'A' and 'Z'
        then (ascii(substring(moved from i for 1)) - 55)::text
      else substring(moved from i for 1)
    end;
    for j in 1 .. char_length(piece) loop
      rest := (rest * 10 + ascii(substring(piece from j for 1)) - 48) % 97;
    end loop;
  end loop;
  return rest = 1;
end;
$$;
revoke execute on function better_supabase.validate_iban(text) from public, anon;
grant execute on function better_supabase.validate_iban(text) to authenticated, service_role;

create or replace function better_supabase.normalize_phone(value text, region text default null)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when compact like '00%' then '+' || regexp_replace(substring(compact from 3), '\D', '', 'g')
    when compact like '+%' then '+' || regexp_replace(substring(compact from 2), '\D', '', 'g')
    when upper(region) = 'NL' and digits like '0%' then '+31' || substring(digits from 2)
    when upper(region) = 'DE' and digits like '0%' then '+49' || substring(digits from 2)
    when upper(region) = 'FR' and digits like '0%' then '+33' || substring(digits from 2)
    when upper(region) = 'GB' and digits like '0%' then '+44' || substring(digits from 2)
    when upper(region) = 'US' then '+1' || digits
    else digits
  end
  from (
    select regexp_replace(coalesce(value, ''), '[\s().-]', '', 'g') as compact
  ) raw,
  lateral (
    select case when compact like '00%' then substring(compact from 3) else compact end as body
  ) body,
  lateral (
    select regexp_replace(body, '\D', '', 'g') as digits
  ) digits
$$;
revoke execute on function better_supabase.normalize_phone(text, text) from public, anon;
grant execute on function better_supabase.normalize_phone(text, text) to authenticated, service_role;
