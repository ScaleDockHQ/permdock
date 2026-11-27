-- better-supabase module: automations
-- @bsb-block automations@2 managed
-- @bsb-hash sha256:96c26fc55f3b6484228cee8c59295f4fc14b6af8a56217f3f2f26abfeda3d380
-- Tenant-editable automations: a filter tree over a subject type's field catalog, tested when a trigger event happens, with action references the action registry runs. Blocks ship default automations (rule_defaults) that every organization gets a copy of, may turn off or edit, and can reset. rule_matches() evaluates a tree in SQL the same way evaluateFilterQuery does in TypeScript.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

-- Tenant rules: a FilterQuery over a subject type's fields, tested when the
-- trigger event happens, and the actions the app runs when it matches.
create table "better_supabase"."automations" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "subject_type" text not null constraint bsb_automations_subject_type_check check ("subject_type" ~ '^[a-z][a-z0-9_-]{0,62}$'),
  "trigger" text not null constraint bsb_automations_trigger_check check (length("trigger") <= 128 and "trigger" ~ '^[a-z][a-z0-9_]*([.:][a-z0-9_]+)*$'),
  "name" text not null constraint bsb_automations_name_check check (length("name") >= 1 and length("name") <= 200),
  "description" text constraint bsb_automations_description_check check (length("description") <= 2000),
  "conditions" jsonb not null,
  "actions" jsonb not null default '[]'::jsonb constraint bsb_automations_actions_check check (jsonb_typeof("actions") = 'array'),
  "enabled" boolean not null default false,
  "stop_processing" boolean not null default false,
  "rank" text collate "C" not null default 'V',
  "version" integer not null default 1,
  "created_by" uuid references auth.users (id) on delete set null default auth.uid(),
  "updated_by" uuid references auth.users (id) on delete set null default auth.uid(),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index "automations_trigger_idx" on "better_supabase"."automations" ("tenant_id", "subject_type", "trigger", "rank");
create index "automations_created_by_idx" on "better_supabase"."automations" ("created_by") where "created_by" is not null;
create index "automations_updated_by_idx" on "better_supabase"."automations" ("updated_by") where "updated_by" is not null;
alter table "better_supabase"."automations" add column "default_key" text;
create unique index "automations_default_key_idx" on "better_supabase"."automations" ("tenant_id", "default_key") where "default_key" is not null;
alter table "better_supabase"."automations" enable row level security;
revoke all on "better_supabase"."automations" from public, anon, authenticated;
grant all on "better_supabase"."automations" to service_role;

-- The automations blocks ship (defineBlock automations). Each organization
-- gets its own copy in rules the first time its rules run or are listed, and
-- may turn it off or edit it; reset_default_rule restores the shipped one.
create table "better_supabase"."automation_defaults" (
  "key" text primary key constraint bsb_automation_defaults_key_check check (length("key") <= 128 and "key" ~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$'),
  "block" text not null,
  "subject_type" text not null constraint bsb_automation_defaults_subject_type_check check ("subject_type" ~ '^[a-z][a-z0-9_-]{0,62}$'),
  "trigger" text not null constraint bsb_automation_defaults_trigger_check check (length("trigger") <= 128 and "trigger" ~ '^[a-z][a-z0-9_]*([.:][a-z0-9_]+)*$'),
  "name" text not null constraint bsb_automation_defaults_name_check check (length("name") >= 1 and length("name") <= 200),
  "description" text constraint bsb_automation_defaults_description_check check (length("description") <= 2000),
  "conditions" jsonb not null default '{"id": "root", "type": "group", "combinator": "and", "rules": []}'::jsonb,
  "actions" jsonb not null default '[]'::jsonb constraint bsb_automation_defaults_actions_check check (jsonb_typeof("actions") = 'array'),
  "enabled" boolean not null default true,
  "updated_at" timestamptz not null default now()
);
alter table "better_supabase"."automation_defaults" enable row level security;
revoke all on "better_supabase"."automation_defaults" from public, anon, authenticated;
grant all on "better_supabase"."automation_defaults" to service_role;

-- Every saved version of a rule's conditions and actions.
create table "better_supabase"."automation_versions" (
  "rule_id" uuid not null references "better_supabase"."automations" ("id") on delete cascade,
  "version" integer not null,
  "tenant_id" uuid not null,
  "name" text not null,
  "conditions" jsonb not null,
  "actions" jsonb not null,
  "saved_by" uuid,
  "saved_at" timestamptz not null default now(),
  primary key ("rule_id", "version")
);
create index "automation_versions_tenant_idx" on "better_supabase"."automation_versions" ("tenant_id");
alter table "better_supabase"."automation_versions" enable row level security;
revoke all on "better_supabase"."automation_versions" from public, anon, authenticated;
grant all on "better_supabase"."automation_versions" to service_role;

-- Live and test evaluations: which rule version saw which subject, and the
-- truth of every condition and group.
create table "better_supabase"."automation_evaluations" (
  "id" bigint generated always as identity primary key,
  "tenant_id" uuid not null,
  "rule_id" uuid not null references "better_supabase"."automations" ("id") on delete cascade,
  "version" integer not null,
  "subject_type" text not null,
  "subject_id" text,
  "trigger" text not null,
  "matched" boolean not null,
  "results" jsonb not null default '{}'::jsonb,
  "mode" text not null default 'live' constraint bsb_automation_evaluations_mode_check check ("mode" in ('live', 'test')),
  "evaluated_by" uuid,
  "evaluated_at" timestamptz not null default now()
);
create index "automation_evaluations_rule_idx" on "better_supabase"."automation_evaluations" ("rule_id", "evaluated_at" desc);
create index "automation_evaluations_tenant_idx" on "better_supabase"."automation_evaluations" ("tenant_id", "evaluated_at" desc);
alter table "better_supabase"."automation_evaluations" enable row level security;
revoke all on "better_supabase"."automation_evaluations" from public, anon, authenticated;
grant all on "better_supabase"."automation_evaluations" to service_role;

-- The fields rules may test, per subject type. The app declares them in code
-- (defineRuleFields) and syncs them with the service role.
create table "better_supabase"."automation_fields" (
  "subject_type" text not null constraint bsb_automation_fields_subject_type_check check ("subject_type" ~ '^[a-z][a-z0-9_-]{0,62}$'),
  "field_id" text not null constraint bsb_automation_fields_field_id_check check (length("field_id") <= 128 and "field_id" ~ '^[A-Za-z_][A-Za-z0-9_]*([.][A-Za-z_][A-Za-z0-9_]*)*$'),
  "label" text not null,
  "description" text,
  "type" text not null constraint bsb_automation_fields_type_check check ("type" in ('text', 'number', 'date', 'select', 'relation', 'multiselect', 'boolean')),
  "path" text not null constraint bsb_automation_fields_path_check check ("path" ~ '^[A-Za-z_][A-Za-z0-9_]*([.][A-Za-z_][A-Za-z0-9_]*)*$'),
  "column_type" text not null,
  "nullable" boolean not null default true,
  "options" jsonb,
  "operators" jsonb,
  "position" integer not null default 0,
  "updated_at" timestamptz not null default now(),
  primary key ("subject_type", "field_id"),
  constraint bsb_automation_fields_check check ("type" <> 'date' or "column_type" in ('date', 'timestamp', 'timestamptz'))
);
alter table "better_supabase"."automation_fields" enable row level security;
revoke all on "better_supabase"."automation_fields" from public, anon, authenticated;
grant all on "better_supabase"."automation_fields" to service_role;

-- A JSON value as text the way the TypeScript evaluator reads it:
-- strings as they are, numbers and booleans printed, anything else null.
create or replace function "better_supabase"."rule_text"(value jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case jsonb_typeof(value)
    when 'string' then value #>> '{}'
    when 'number' then value::text
    when 'boolean' then value::text
  end
$$;

create or replace function "better_supabase"."rule_numeric"(value jsonb)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
begin
  if jsonb_typeof(value) = 'number' then
    return (value #>> '{}')::numeric;
  end if;
  if jsonb_typeof(value) is distinct from 'string' then
    return null;
  end if;
  v_text := trim(value #>> '{}');
  if v_text = '' or lower(v_text) in ('nan', 'infinity', '+infinity', '-infinity', 'inf', '+inf', '-inf') then
    return null;
  end if;
  return v_text::numeric;
exception when others then
  return null;
end;
$$;

create or replace function "better_supabase"."rule_boolean"(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(value) = 'boolean' then (value #>> '{}')::boolean
    when value = '"true"'::jsonb then true
    when value = '"false"'::jsonb then false
  end
$$;

-- An array value, or a string holding a JSON array, as text elements.
create or replace function "better_supabase"."rule_list"(value jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_array jsonb := value;
begin
  if jsonb_typeof(value) = 'string' and left(value #>> '{}', 1) = '[' then
    v_array := (value #>> '{}')::jsonb;
  end if;
  if jsonb_typeof(v_array) is distinct from 'array' then
    return null;
  end if;
  return coalesce((
    select array_agg(case jsonb_typeof(e.value) when 'string' then e.value #>> '{}' else e.value::text end order by e.n)
    from jsonb_array_elements(v_array) with ordinality e(value, n)
  ), '{}');
exception when others then
  return null;
end;
$$;

-- A date value as a timestamp in the column's own ordering: the UTC instant
-- for timestamptz, the day for date and the wall clock for timestamp.
create or replace function "better_supabase"."rule_moment"(kind text, value jsonb)
returns timestamp
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text text;
begin
  if jsonb_typeof(value) is distinct from 'string' then
    return null;
  end if;
  v_text := value #>> '{}';
  if kind = 'timestamptz' then
    return v_text::timestamptz at time zone 'UTC';
  end if;
  if kind = 'date' then
    return left(v_text, 10)::date::timestamp;
  end if;
  return v_text::timestamp;
exception when others then
  return null;
end;
$$;

-- The [start, end) bounds of a date value ({ date, time, relative }) in the
-- same ordering as rule_moment, the way dateBounds resolves them.
create or replace function "better_supabase"."rule_bounds"(kind text, value jsonb, time_zone text, now timestamptz)
returns timestamp[]
language plpgsql
stable
set search_path = ''
as $$
declare
  v_day date;
  v_offset integer;
  v_time time;
  v_from timestamp;
  v_to timestamp;
begin
  if jsonb_typeof(value -> 'relative') = 'object' then
    v_day := (rule_bounds.now at time zone rule_bounds.time_zone)::date;
    v_offset := coalesce((value -> 'relative' ->> 'offset')::integer, 0);
    v_day := (v_day + case value -> 'relative' ->> 'unit'
      when 'day' then make_interval(days => v_offset)
      when 'week' then make_interval(weeks => v_offset)
      when 'month' then make_interval(months => v_offset)
      else make_interval(years => v_offset)
    end)::date;
  else
    v_day := (value ->> 'date')::date;
  end if;
  if kind = 'date' then
    return array[v_day::timestamp, (v_day + 1)::timestamp];
  end if;
  v_time := (value ->> 'time')::time;
  v_from := v_day + coalesce(v_time, time '00:00');
  v_to := case when v_time is null then v_from + interval '1 day' else v_from + interval '1 minute' end;
  if kind = 'timestamp' then
    return array[v_from, v_to];
  end if;
  return array[
    (v_from at time zone rule_bounds.time_zone) at time zone 'UTC',
    (v_to at time zone rule_bounds.time_zone) at time zone 'UTC'
  ];
end;
$$;

create or replace function "better_supabase"."rule_date"(kind text, operator text, operand jsonb, value jsonb, time_zone text, now timestamptz)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_at timestamp := "better_supabase"."rule_moment"(kind, value);
  v_bounds timestamp[];
begin
  if v_at is null then
    return null;
  end if;
  if operator = 'between' then
    return v_at >= ("better_supabase"."rule_bounds"(kind, operand -> 0, time_zone, now))[1]
      and v_at < ("better_supabase"."rule_bounds"(kind, operand -> 1, time_zone, now))[2];
  end if;
  v_bounds := "better_supabase"."rule_bounds"(kind, operand, time_zone, now);
  case operator
    when 'is' then return v_at >= v_bounds[1] and v_at < v_bounds[2];
    when 'is_before' then return v_at < v_bounds[1];
    when 'is_after' then return v_at >= v_bounds[2];
    when 'is_on_or_before' then return v_at < v_bounds[2];
    when 'is_on_or_after' then return v_at >= v_bounds[1];
  end case;
end;
$$;

create or replace function "better_supabase"."rule_equal"(type text, operand jsonb, value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_boolean boolean;
  v_number numeric;
  v_text text;
begin
  if value is null then
    return null;
  end if;
  if type = 'boolean' then
    v_boolean := "better_supabase"."rule_boolean"(value);
    return case when v_boolean is null then null else v_boolean = coalesce(operand in ('true'::jsonb, '"true"'::jsonb), false) end;
  end if;
  if type = 'number' then
    v_number := "better_supabase"."rule_numeric"(value);
    return case when v_number is null then null else coalesce(v_number = "better_supabase"."rule_numeric"(operand), false) end;
  end if;
  v_text := "better_supabase"."rule_text"(value);
  return case when v_text is null then null else coalesce(v_text = "better_supabase"."rule_text"(operand), false) end;
end;
$$;

-- The truth of a positive operator (negations are handled by rule_node).
create or replace function "better_supabase"."rule_positive"(type text, kind text, operator text, operand jsonb, value jsonb, time_zone text, now timestamptz)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text text := "better_supabase"."rule_text"(value);
  v_needle text;
  v_value numeric;
  v_low numeric;
  v_high numeric;
  v_list text[];
begin
  case operator
    when 'empty' then
      return value is null or (type = 'text' and value = '""'::jsonb);
    when 'contains', 'starts_with', 'ends_with' then
      if v_text is null then
        return null;
      end if;
      v_needle := lower(coalesce(operand #>> '{}', ''));
      return case operator
        when 'contains' then strpos(lower(v_text), v_needle) > 0
        when 'starts_with' then left(lower(v_text), length(v_needle)) = v_needle
        else right(lower(v_text), length(v_needle)) = v_needle
      end;
    when 'eq' then
      return "better_supabase"."rule_equal"(type, operand, value);
    when 'gt', 'gte', 'lt', 'lte' then
      v_value := "better_supabase"."rule_numeric"(value);
      v_low := "better_supabase"."rule_numeric"(operand);
      if v_value is null or v_low is null then
        return null;
      end if;
      return case operator
        when 'gt' then v_value > v_low
        when 'gte' then v_value >= v_low
        when 'lt' then v_value < v_low
        else v_value <= v_low
      end;
    when 'is_any_of' then
      if value is null then
        return null;
      end if;
      return v_text is not null and jsonb_typeof(operand) = 'array'
        and exists (select 1 from jsonb_array_elements(operand) e where "better_supabase"."rule_text"(e.value) = v_text);
    when 'has_any_of', 'has_all_of' then
      v_list := "better_supabase"."rule_list"(value);
      if v_list is null or jsonb_typeof(operand) is distinct from 'array' then
        return null;
      end if;
      if operator = 'has_any_of' then
        return exists (select 1 from unnest("better_supabase"."rule_list"(operand)) w where w = any (v_list));
      end if;
      return not exists (select 1 from unnest("better_supabase"."rule_list"(operand)) w where not (w = any (v_list)));
    when 'is' then
      if type = 'date' then
        return "better_supabase"."rule_date"(kind, operator, operand, value, time_zone, now);
      end if;
      return "better_supabase"."rule_equal"(type, operand, value);
    when 'between' then
      if type = 'date' then
        return "better_supabase"."rule_date"(kind, operator, operand, value, time_zone, now);
      end if;
      v_value := "better_supabase"."rule_numeric"(value);
      v_low := least("better_supabase"."rule_numeric"(operand -> 0), "better_supabase"."rule_numeric"(operand -> 1));
      v_high := greatest("better_supabase"."rule_numeric"(operand -> 0), "better_supabase"."rule_numeric"(operand -> 1));
      if v_value is null or v_low is null or v_high is null then
        return null;
      end if;
      return v_value >= v_low and v_value <= v_high;
    else
      return "better_supabase"."rule_date"(kind, operator, operand, value, time_zone, now);
  end case;
end;
$$;

-- One node of a tree: { truth, results } by node id, or null when the node
-- takes no part (an unfinished rule, an unknown field, an empty group).
create or replace function "better_supabase"."rule_node"(node jsonb, subject jsonb, fields jsonb, time_zone text, now timestamptz)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_field jsonb;
  v_value jsonb;
  v_operator text := coalesce(node ->> 'operator', '');
  v_base text;
  v_negative boolean;
  v_truth boolean;
  v_part jsonb;
  v_parts boolean[] := '{}';
  v_results jsonb := '{}'::jsonb;
begin
  if node ->> 'type' = 'rule' then
    v_field := fields -> (
      select string_agg(p.value, '.' order by p.n)
      from jsonb_array_elements_text(coalesce(node -> 'path', '[]'::jsonb)) with ordinality p(value, n)
    );
    if v_operator = '' or v_field is null then
      return null;
    end if;
    v_value := subject #> string_to_array(v_field ->> 'column', '.');
    if jsonb_typeof(v_value) = 'null' then
      v_value := null;
    end if;
    v_base := case v_operator when 'not_empty' then 'empty' when 'not_contains' then 'contains' when 'is_not' then 'is' when 'neq' then 'eq' when 'not_between' then 'between' when 'is_none_of' then 'is_any_of' when 'has_none_of' then 'has_any_of' end;
    v_negative := (v_base is not null) <> coalesce((node ->> 'negated')::boolean, false);
    v_operator := coalesce(v_base, v_operator);
    v_truth := "better_supabase"."rule_positive"(v_field ->> 'type', coalesce(v_field ->> 'columnType', 'text'), v_operator, node -> 'value', v_value, time_zone, now);
    if v_negative then
      -- "is not x" also matches records without a value, except for "is not empty".
      if coalesce((v_field ->> 'nullable')::boolean, true) and v_operator <> 'empty' and v_value is null then
        v_truth := true;
      else
        v_truth := not v_truth;
      end if;
    end if;
    return jsonb_build_object('truth', v_truth, 'results', jsonb_build_object(node ->> 'id', v_truth));
  end if;
  for v_part in
    select "better_supabase"."rule_node"(e.value, subject, fields, time_zone, now)
    from jsonb_array_elements(coalesce(node -> 'rules', '[]'::jsonb)) with ordinality e(value, n)
    order by e.n
  loop
    if v_part is not null then
      v_parts := v_parts || (v_part ->> 'truth')::boolean;
      v_results := v_results || (v_part -> 'results');
    end if;
  end loop;
  if cardinality(v_parts) = 0 then
    return null;
  end if;
  if node ->> 'combinator' = 'and' then
    v_truth := not (false = any (v_parts));
  else
    v_truth := true = any (v_parts);
  end if;
  return jsonb_build_object('truth', v_truth, 'results', v_results || jsonb_build_object(node ->> 'id', v_truth));
end;
$$;

-- A filter tree on one subject: { matched, results }, the same answer as
-- evaluateFilterQuery. fields maps a field id to { type, column,
-- columnType, nullable }, as rule_field_map returns it.
create or replace function "better_supabase"."rule_evaluate"(conditions jsonb, subject jsonb, fields jsonb, time_zone text default 'UTC', now timestamptz default now())
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_node jsonb := "better_supabase"."rule_node"(conditions, subject, fields, time_zone, now);
begin
  return jsonb_build_object(
    'matched', v_node is null or coalesce((v_node ->> 'truth')::boolean, false),
    'results', coalesce(v_node -> 'results', '{}'::jsonb)
  );
end;
$$;

create or replace function "better_supabase"."rule_matches"(conditions jsonb, subject jsonb, fields jsonb, time_zone text default 'UTC', now timestamptz default now())
returns boolean
language sql
stable
set search_path = ''
as $$
  select ("better_supabase"."rule_evaluate"(conditions, subject, fields, time_zone, now) ->> 'matched')::boolean
$$;

-- Checks a tree against a field map and the operator table; returns the
-- number of conditions. Raises AUTOMATION_INVALID with the reason.
create or replace function "better_supabase"."rule_check"(node jsonb, fields jsonb, depth integer default 1)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_operators constant jsonb := '{"text":{"contains":"one","not_contains":"one","starts_with":"one","ends_with":"one","is":"one","is_not":"one","empty":"none","not_empty":"none"},"number":{"eq":"one","neq":"one","gt":"one","gte":"one","lt":"one","lte":"one","between":"range","not_between":"range","empty":"none","not_empty":"none"},"date":{"is":"one","is_not":"one","is_before":"one","is_after":"one","is_on_or_before":"one","is_on_or_after":"one","between":"range","not_between":"range","empty":"none","not_empty":"none"},"select":{"is":"one","is_not":"one","is_any_of":"many","is_none_of":"many","empty":"none","not_empty":"none"},"relation":{"is":"one","is_not":"one","is_any_of":"many","is_none_of":"many","empty":"none","not_empty":"none"},"multiselect":{"has_any_of":"many","has_all_of":"many","has_none_of":"many","empty":"none","not_empty":"none"},"boolean":{"is":"one","is_not":"one","empty":"none","not_empty":"none"}}'::jsonb;
  v_field jsonb;
  v_path text;
  v_operator text;
  v_arity text;
  v_count integer := 0;
  v_child jsonb;
begin
  if jsonb_typeof(node) is distinct from 'object' or jsonb_typeof(node -> 'id') is distinct from 'string'
    or length(node ->> 'id') not between 1 and 64 then
    raise exception 'Every condition and group needs an id' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if node ->> 'type' = 'rule' then
    if jsonb_typeof(node -> 'path') is distinct from 'array' or jsonb_array_length(node -> 'path') = 0 then
      raise exception 'A condition needs a field path' using errcode = '22023', hint = 'AUTOMATION_INVALID';
    end if;
    v_operator := coalesce(node ->> 'operator', '');
    if v_operator = '' then
      return 0;
    end if;
    select string_agg(p.value, '.' order by p.n) into v_path
    from jsonb_array_elements_text(node -> 'path') with ordinality p(value, n);
    v_field := fields -> v_path;
    if v_field is null then
      raise exception 'No rule field %', v_path using errcode = '22023', hint = 'RULE_FIELD_UNKNOWN';
    end if;
    v_arity := v_operators -> (v_field ->> 'type') ->> v_operator;
    if v_arity is null or (jsonb_typeof(v_field -> 'operators') = 'array' and not (v_field -> 'operators') ? v_operator) then
      raise exception 'The field % has no operator %', v_path, v_operator using errcode = '22023', hint = 'RULE_OPERATOR_INVALID';
    end if;
    if (v_arity = 'one' and coalesce(jsonb_typeof(node -> 'value'), 'null') = 'null')
      or (v_arity = 'one' and v_field ->> 'type' = 'date' and jsonb_typeof(node -> 'value') is distinct from 'object')
      or (v_arity = 'many' and (jsonb_typeof(node -> 'value') is distinct from 'array' or jsonb_array_length(node -> 'value') not between 1 and 100))
      or (v_arity = 'range' and (jsonb_typeof(node -> 'value') is distinct from 'array' or jsonb_array_length(node -> 'value') <> 2)) then
      raise exception 'The condition on % has no valid value for %', v_path, v_operator using errcode = '22023', hint = 'RULE_VALUE_INVALID';
    end if;
    if (node -> 'value') is not null and v_arity <> 'none' and length((node -> 'value')::text) > 10000 then
      raise exception 'The value for % is too long', v_path using errcode = '22023', hint = 'RULE_VALUE_INVALID';
    end if;
    return 1;
  end if;
  if node ->> 'type' is distinct from 'group' or coalesce(node ->> 'combinator', '') not in ('and', 'or')
    or jsonb_typeof(node -> 'rules') is distinct from 'array' then
    raise exception 'A group needs a combinator (and, or) and a list of rules' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if depth > 4 then
    raise exception 'Groups nest at most 4 deep' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  for v_child in select x.value from jsonb_array_elements(node -> 'rules') x loop
    v_count := v_count + "better_supabase"."rule_check"(v_child, fields, depth + 1);
  end loop;
  if v_count > 50 then
    raise exception 'A rule holds at most 50 conditions' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  return v_count;
end;
$$;

-- Replaces a subject type's field catalog (service role). fields is an array of { id,
-- label, description, type, column, columnType, nullable, options, operators }; returns
-- how many fields the subject type has.
create or replace function "better_supabase"."sync_rule_fields"(subject_type text, fields jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_count integer;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role syncs rule fields' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if jsonb_typeof(fields) is distinct from 'array' then
    raise exception 'fields must be an array' using errcode = '22023', hint = 'AUTOMATION_FIELDS_INVALID';
  end if;
  insert into "better_supabase"."automation_fields" ("subject_type", "field_id", "label", "description", "type", "path", "column_type", "nullable", "options", "operators", "position")
  select sync_rule_fields.subject_type, x.value ->> 'id', coalesce(x.value ->> 'label', x.value ->> 'id'), x.value ->> 'description',
    x.value ->> 'type', coalesce(x.value ->> 'column', x.value ->> 'id'), coalesce(x.value ->> 'columnType', 'text'),
    coalesce((x.value ->> 'nullable')::boolean, true), x.value -> 'options', x.value -> 'operators', x.n::integer
  from jsonb_array_elements(fields) with ordinality x(value, n)
  on conflict ("subject_type", "field_id") do update set
    "label" = excluded."label",
    "description" = excluded."description",
    "type" = excluded."type",
    "path" = excluded."path",
    "column_type" = excluded."column_type",
    "nullable" = excluded."nullable",
    "options" = excluded."options",
    "operators" = excluded."operators",
    "position" = excluded."position",
    "updated_at" = now();
  delete from "better_supabase"."automation_fields" x
  where x."subject_type" = sync_rule_fields.subject_type
    and not exists (select 1 from jsonb_array_elements(fields) y where y.value ->> 'id' = x."field_id");
  select count(*) into v_count from "better_supabase"."automation_fields" x where x."subject_type" = sync_rule_fields.subject_type;
  return v_count;
exception when check_violation or not_null_violation then
  raise exception 'A rule field has an invalid id, type, column or column type' using errcode = '22023', hint = 'AUTOMATION_FIELDS_INVALID';
end;
$$;

-- The field catalog, for the editor: one subject type, or all of them.
create or replace function "better_supabase"."rule_fields_list"(subject_type text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('subjectType', x."subject_type", 'id', x."field_id", 'label', x."label", 'description', x."description", 'type', x."type", 'column', x."path", 'columnType', x."column_type", 'nullable', x."nullable", 'options', x."options", 'operators', x."operators") order by x."subject_type", x."position"), '[]'::jsonb)
  from "better_supabase"."automation_fields" x
  where rule_fields_list.subject_type is null or x."subject_type" = rule_fields_list.subject_type
$$;

-- The fields argument of rule_evaluate for a subject type.
create or replace function "better_supabase"."rule_field_map"(subject_type text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(x."field_id", jsonb_build_object(
    'type', x."type", 'column', x."path", 'columnType', x."column_type",
    'nullable', x."nullable", 'operators', x."operators"
  )), '{}'::jsonb)
  from "better_supabase"."automation_fields" x where x."subject_type" = rule_field_map.subject_type
$$;

-- Creates or changes a rule. rule is { id?, version?, subjectType, trigger, name,
-- description, conditions, actions, enabled, stopProcessing }; keys left out keep
-- their value. Creating or changing a disabled rule takes the edit permission;
-- enabling one, or changing an enabled one, takes publish. version must be the stored one.
create or replace function "better_supabase"."upsert_rule"(tenant uuid, rule jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_id uuid;
  v_old "better_supabase"."automations";
  v_row "better_supabase"."automations";
  v_subject_type text;
  v_trigger text;
  v_name text;
  v_description text;
  v_conditions jsonb;
  v_actions jsonb;
  v_enabled boolean;
  v_stop boolean;
  v_fields jsonb;
  v_action jsonb;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if jsonb_typeof(rule) is distinct from 'object' then
    raise exception 'rule must be an object' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  v_id := nullif(rule ->> 'id', '')::uuid;
  if v_id is not null then
    select * into v_old from "better_supabase"."automations" x where x."id" = v_id and x."tenant_id" = upsert_rule.tenant for update;
    if v_old."id" is null then
      raise exception 'No rule in this organization has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
    end if;
    if rule ? 'version' and (rule ->> 'version')::integer is distinct from v_old."version" then
      raise exception 'The rule changed since it was read' using errcode = '40001', hint = 'AUTOMATION_CONFLICT';
    end if;
    if rule ? 'subjectType' and rule ->> 'subjectType' is distinct from v_old."subject_type" then
      raise exception 'A rule''s subject type can''t change' using errcode = '22023', hint = 'AUTOMATION_INVALID';
    end if;
  end if;
  v_subject_type := coalesce(v_old."subject_type", rule ->> 'subjectType');
  v_trigger := coalesce(rule ->> 'trigger', v_old."trigger");
  v_name := coalesce(nullif(trim(rule ->> 'name'), ''), v_old."name");
  v_description := case when rule ? 'description' then nullif(trim(rule ->> 'description'), '') else v_old."description" end;
  v_conditions := coalesce(rule -> 'conditions', v_old."conditions", '{"id": "root", "type": "group", "combinator": "and", "rules": []}'::jsonb);
  v_actions := coalesce(rule -> 'actions', v_old."actions", '[]'::jsonb);
  v_enabled := coalesce((rule ->> 'enabled')::boolean, v_old."enabled", false);
  v_stop := coalesce((rule ->> 'stopProcessing')::boolean, v_old."stop_processing", false);
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (case when (v_enabled or coalesce(v_old."enabled", false)) then coalesce(better_supabase.can('tenant', upsert_rule.tenant, 'automations.publish'), false) else coalesce(better_supabase.can('tenant', upsert_rule.tenant, 'automations.write'), false) end)) then
    raise exception 'You need % to save this rule', case when (v_enabled or coalesce(v_old."enabled", false)) then '''automations.publish''' else '''automations.write''' end using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if v_subject_type is null or v_subject_type !~ '^[a-z][a-z0-9_-]{0,62}$' then
    raise exception 'A rule needs a subject type' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if v_trigger is null or length(v_trigger) > 128 or v_trigger !~ '^[a-z][a-z0-9_]*([.:][a-z0-9_]+)*$' then
    raise exception 'A rule needs a trigger such as expense.submitted' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if v_name is null or length(v_name) > 200 then
    raise exception 'A rule needs a name of at most 200 characters' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  v_fields := "better_supabase"."rule_field_map"(v_subject_type);
  if v_fields = '{}'::jsonb and v_old."default_key" is null then
    raise exception 'No rule fields for %; sync them first', v_subject_type using errcode = '22023', hint = 'RULE_SUBJECT_UNKNOWN';
  end if;
  perform "better_supabase"."rule_check"(v_conditions, v_fields, 1);
  if jsonb_typeof(v_actions) is distinct from 'array' or jsonb_array_length(v_actions) > 20 then
    raise exception 'actions must be an array of at most 20 entries' using errcode = '22023', hint = 'AUTOMATION_ACTIONS_INVALID';
  end if;
  for v_action in select x.value from jsonb_array_elements(v_actions) x loop
    if jsonb_typeof(v_action) is distinct from 'object' or v_action ->> 'kind' is null
      or length(v_action ->> 'kind') > 128 or v_action ->> 'kind' !~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$'
      or (v_action ? 'config' and jsonb_typeof(v_action -> 'config') is distinct from 'object') then
      raise exception 'Every action needs a kind such as approvals.request and an optional config object' using errcode = '22023', hint = 'AUTOMATION_ACTIONS_INVALID';
    end if;
  end loop;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_automation_save"(uuid, jsonb)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::jsonb)', v_hook::oid::regproc)
        using upsert_rule.tenant, upsert_rule.rule;
    end if;
  end;
  if v_old."id" is null then
    insert into "better_supabase"."automations" ("tenant_id", "subject_type", "trigger", "name", "description", "conditions", "actions", "enabled", "stop_processing", "rank")
    values (upsert_rule.tenant, v_subject_type, v_trigger, v_name, v_description, v_conditions, v_actions, v_enabled, v_stop,
      case
    when (select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = upsert_rule.tenant and x."subject_type" = v_subject_type) is null then 'V'
    when length(substring((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = upsert_rule.tenant and x."subject_type" = v_subject_type) from '^z*')) = length((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = upsert_rule.tenant and x."subject_type" = v_subject_type)) then (select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = upsert_rule.tenant and x."subject_type" = v_subject_type) || 'V'
    else left((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = upsert_rule.tenant and x."subject_type" = v_subject_type), length(substring((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = upsert_rule.tenant and x."subject_type" = v_subject_type) from '^z*'))) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (strpos('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', substr((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = upsert_rule.tenant and x."subject_type" = v_subject_type), length(substring((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = upsert_rule.tenant and x."subject_type" = v_subject_type) from '^z*')) + 1, 1)) - 1 + 62) / 2 + 1, 1)
  end)
    returning * into v_row;
  elsif v_old."trigger" = v_trigger and v_old."name" = v_name
    and v_old."description" is not distinct from v_description
    and v_old."conditions" = v_conditions and v_old."actions" = v_actions
    and v_old."enabled" = v_enabled and v_old."stop_processing" = v_stop then
    return jsonb_build_object('id', v_old."id", 'organizationId', v_old."tenant_id", 'subjectType', v_old."subject_type", 'trigger', v_old."trigger", 'name', v_old."name", 'description', v_old."description", 'conditions', v_old."conditions", 'actions', v_old."actions", 'enabled', v_old."enabled", 'stopProcessing', v_old."stop_processing", 'rank', v_old."rank", 'version', v_old."version", 'createdBy', v_old."created_by", 'updatedBy', v_old."updated_by", 'createdAt', v_old."created_at", 'updatedAt', v_old."updated_at", 'defaultKey', v_old."default_key");
  else
    update "better_supabase"."automations" x set
      "trigger" = v_trigger,
      "name" = v_name,
      "description" = v_description,
      "conditions" = v_conditions,
      "actions" = v_actions,
      "enabled" = v_enabled,
      "stop_processing" = v_stop,
      "version" = x."version" + 1,
      "updated_by" = auth.uid(),
      "updated_at" = now()
    where x."id" = v_old."id"
    returning * into v_row;
  end if;
  insert into "better_supabase"."automation_versions" ("rule_id", "version", "tenant_id", "name", "conditions", "actions", "saved_by")
  values (v_row."id", v_row."version", v_row."tenant_id", v_row."name", v_row."conditions", v_row."actions", auth.uid())
  on conflict do nothing;
  if v_old."id" is null then
    perform better_supabase.audit_event(
    event_type => 'automation.created',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  else
    perform better_supabase.audit_event(
    event_type => 'automation.updated',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  end if;
  if v_row."enabled" and not coalesce(v_old."enabled", false) then
    perform better_supabase.audit_event(
    event_type => 'automation.enabled',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  elsif not v_row."enabled" and coalesce(v_old."enabled", false) then
    perform better_supabase.audit_event(
    event_type => 'automation.disabled',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_automation_save"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$$;

-- An organization's rules in evaluation order, by subject type, trigger and enabled.
create or replace function "better_supabase"."rules_list"(tenant uuid, subject_type text default null, trigger text default null, enabled boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', rules_list.tenant, 'automations.read'), false)) then
    raise exception 'You may not read this organization''s rules' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  perform "better_supabase"."install_default_rules"(rules_list.tenant);
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'trigger', x."trigger", 'name', x."name", 'description', x."description", 'conditions', x."conditions", 'actions', x."actions", 'enabled', x."enabled", 'stopProcessing', x."stop_processing", 'rank', x."rank", 'version', x."version", 'createdBy', x."created_by", 'updatedBy', x."updated_by", 'createdAt', x."created_at", 'updatedAt', x."updated_at", 'defaultKey', x."default_key") order by x."subject_type", x."trigger", x."rank" collate "C"), '[]'::jsonb)
    from "better_supabase"."automations" x
    where x."tenant_id" = rules_list.tenant
      and (rules_list.subject_type is null or x."subject_type" = rules_list.subject_type)
      and (rules_list.trigger is null or x."trigger" = rules_list.trigger)
      and (rules_list.enabled is null or x."enabled" = rules_list.enabled)
  );
end;
$$;

-- One rule, or null when the caller can't read it.
create or replace function "better_supabase"."rule_get"(id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."automations";
begin
  select * into v_row from "better_supabase"."automations" x where x."id" = rule_get.id;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.read'), false)) then
    return null;
  end if;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$$;

-- A rule's saved versions, newest first.
create or replace function "better_supabase"."rule_versions_list"(id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select x."tenant_id" into v_tenant from "better_supabase"."automations" x where x."id" = rule_versions_list.id;
  if v_tenant is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'automations.read'), false)) then
    return '[]'::jsonb;
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'ruleId', x."rule_id", 'version', x."version", 'name', x."name",
      'conditions', x."conditions", 'actions', x."actions",
      'savedBy', x."saved_by", 'savedAt', x."saved_at"
    ) order by x."version" desc), '[]'::jsonb)
    from "better_supabase"."automation_versions" x where x."rule_id" = rule_versions_list.id
  );
end;
$$;

-- Turns a rule on or off (publish permission).
create or replace function "better_supabase"."set_rule_enabled"(id uuid, enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."automations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."automations" x where x."id" = set_rule_enabled.id for update;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.read'), false)) then
    raise exception 'No rule you can read has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.publish'), false)) then
    raise exception 'Publishing rules needs the publish permission' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if v_row."enabled" = coalesce(set_rule_enabled.enabled, false) then
    return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
  end if;
  update "better_supabase"."automations" x set "enabled" = coalesce(set_rule_enabled.enabled, false), "updated_by" = auth.uid(), "updated_at" = now()
  where x."id" = v_row."id" returning * into v_row;
  if v_row."enabled" then
    perform better_supabase.audit_event(
    event_type => 'automation.enabled',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  else
    perform better_supabase.audit_event(
    event_type => 'automation.disabled',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  end if;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$$;

-- Moves a rule to a rank key the client computed with rankBetween.
create or replace function "better_supabase"."rank_rule"(id uuid, rank text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."automations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."automations" x where x."id" = rank_rule.id for update;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.read'), false)) then
    raise exception 'No rule you can read has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (case when v_row."enabled" then coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.publish'), false) else coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.write'), false) end)) then
    raise exception 'You need % to move this rule', case when v_row."enabled" then '''automations.publish''' else '''automations.write''' end using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if rank_rule.rank is null or rank_rule.rank !~ '^[0-9A-Za-z]*[1-9A-Za-z]$' then
    raise exception 'rank must be a key from rankBetween' using errcode = '22023', hint = 'AUTOMATION_RANK_INVALID';
  end if;
  update "better_supabase"."automations" x set "rank" = rank_rule.rank, "updated_at" = now()
  where x."id" = v_row."id" returning * into v_row;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$$;

-- Removes a rule with its versions and evaluations (admin permission);
-- false when there is none the caller may remove.
create or replace function "better_supabase"."delete_rule"(id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."automations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."automations" x where x."id" = delete_rule.id;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.manage'), false)) then
    return false;
  end if;
  if v_row."default_key" is not null then
    raise exception 'A block ships this automation; turn it off instead of removing it' using errcode = '22023', hint = 'AUTOMATION_DEFAULT';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_automation_remove"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using delete_rule.id;
    end if;
  end;
  delete from "better_supabase"."automations" x where x."id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'automation.deleted',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_automation_remove"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
  return true;
end;
$$;

-- The enabled rules for a trigger that match subject, in rank order, each
-- with its results; a matched rule with stop_processing ends the list.
create or replace function "better_supabase"."matching_rules"(tenant uuid, subject_type text, trigger text, subject jsonb, time_zone text default 'UTC')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fields jsonb;
  v_rule "better_supabase"."automations";
  v_result jsonb;
  v_matches jsonb := '[]'::jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', matching_rules.tenant, 'automations.read'), false)) then
    raise exception 'You may not read this organization''s rules' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  v_fields := "better_supabase"."rule_field_map"(matching_rules.subject_type);
  for v_rule in
    select * from "better_supabase"."automations" x
    where x."tenant_id" = matching_rules.tenant and x."subject_type" = matching_rules.subject_type
      and x."trigger" = matching_rules.trigger and x."enabled"
    order by x."rank" collate "C"
  loop
    v_result := "better_supabase"."rule_evaluate"(v_rule."conditions", matching_rules.subject, v_fields, coalesce(matching_rules.time_zone, 'UTC'), now());
    if (v_result ->> 'matched')::boolean then
      v_matches := v_matches || jsonb_build_array(jsonb_build_object('rule', jsonb_build_object('id', v_rule."id", 'organizationId', v_rule."tenant_id", 'subjectType', v_rule."subject_type", 'trigger', v_rule."trigger", 'name', v_rule."name", 'description', v_rule."description", 'conditions', v_rule."conditions", 'actions', v_rule."actions", 'enabled', v_rule."enabled", 'stopProcessing', v_rule."stop_processing", 'rank', v_rule."rank", 'version', v_rule."version", 'createdBy', v_rule."created_by", 'updatedBy', v_rule."updated_by", 'createdAt', v_rule."created_at", 'updatedAt', v_rule."updated_at", 'defaultKey', v_rule."default_key"), 'results', v_result -> 'results'));
      exit when v_rule."stop_processing";
    end if;
  end loop;
  return v_matches;
end;
$$;

-- Logs one evaluation. Live entries come from the service role and emit
-- automation.matched when they match; a test entry takes the edit permission.
create or replace function "better_supabase"."record_rule_evaluation"(rule uuid, subject_id text, matched boolean, results jsonb default '{}'::jsonb, mode text default 'live')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule "better_supabase"."automations";
  v_row "better_supabase"."automation_evaluations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_rule from "better_supabase"."automations" x where x."id" = record_rule_evaluation.rule;
  if v_rule."id" is null then
    raise exception 'No rule has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
  end if;
  if coalesce(record_rule_evaluation.mode, 'live') not in ('live', 'test') then
    raise exception 'mode is live or test' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if coalesce(record_rule_evaluation.mode, 'live') = 'live' and not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role records live evaluations' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_rule."tenant_id", 'automations.write'), false)) then
    raise exception 'Testing rules needs the edit permission' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  insert into "better_supabase"."automation_evaluations" ("tenant_id", "rule_id", "version", "subject_type", "subject_id", "trigger", "matched", "results", "mode", "evaluated_by")
  values (v_rule."tenant_id", v_rule."id", v_rule."version", v_rule."subject_type", record_rule_evaluation.subject_id, v_rule."trigger",
    coalesce(record_rule_evaluation.matched, false), coalesce(record_rule_evaluation.results, '{}'::jsonb), coalesce(record_rule_evaluation.mode, 'live'), auth.uid())
  returning * into v_row;
  if v_row."mode" = 'live' and v_row."matched" then
    null;
  end if;
  return jsonb_build_object('id', v_row."id"::text, 'organizationId', v_row."tenant_id", 'ruleId', v_row."rule_id", 'version', v_row."version", 'subjectType', v_row."subject_type", 'subjectId', v_row."subject_id", 'trigger', v_row."trigger", 'matched', v_row."matched", 'results', v_row."results", 'mode', v_row."mode", 'evaluatedBy', v_row."evaluated_by", 'evaluatedAt', v_row."evaluated_at");
end;
$$;

-- For database triggers and jobs (service role): evaluates the enabled rules for a
-- trigger, logs each one live and returns the matches as matching_rules does. A null
-- subject_type tests every rule for the trigger against its own subject type's fields.
create or replace function "better_supabase"."run_rules"(tenant uuid, subject_type text, trigger text, subject_id text, subject jsonb, time_zone text default 'UTC')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fields jsonb;
  v_rule "better_supabase"."automations";
  v_result jsonb;
  v_matches jsonb := '[]'::jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role runs rules' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  perform "better_supabase"."install_default_rules"(run_rules.tenant);
  v_fields := "better_supabase"."rule_field_map"(run_rules.subject_type);
  for v_rule in
    select * from "better_supabase"."automations" x
    where x."tenant_id" = run_rules.tenant
      and (run_rules.subject_type is null or x."subject_type" = run_rules.subject_type)
      and x."trigger" = run_rules.trigger and x."enabled"
    order by x."rank" collate "C"
  loop
    if run_rules.subject_type is null then
      v_fields := "better_supabase"."rule_field_map"(v_rule."subject_type");
    end if;
    v_result := "better_supabase"."rule_evaluate"(v_rule."conditions", run_rules.subject, v_fields, coalesce(run_rules.time_zone, 'UTC'), now());
    perform "better_supabase"."record_rule_evaluation"(v_rule."id", run_rules.subject_id, (v_result ->> 'matched')::boolean, v_result -> 'results', 'live');
    if (v_result ->> 'matched')::boolean then
      v_matches := v_matches || jsonb_build_array(jsonb_build_object('rule', jsonb_build_object('id', v_rule."id", 'organizationId', v_rule."tenant_id", 'subjectType', v_rule."subject_type", 'trigger', v_rule."trigger", 'name', v_rule."name", 'description', v_rule."description", 'conditions', v_rule."conditions", 'actions', v_rule."actions", 'enabled', v_rule."enabled", 'stopProcessing', v_rule."stop_processing", 'rank', v_rule."rank", 'version', v_rule."version", 'createdBy', v_rule."created_by", 'updatedBy', v_rule."updated_by", 'createdAt', v_rule."created_at", 'updatedAt', v_rule."updated_at", 'defaultKey', v_rule."default_key"), 'results', v_result -> 'results'));
      exit when v_rule."stop_processing";
    end if;
  end loop;
  return v_matches;
end;
$$;

-- Copies the default automations an organization doesn't have yet into its
-- rules (service role); returns how many it copied.
create or replace function "better_supabase"."install_default_rules"(tenant uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into "better_supabase"."automations" ("tenant_id", "subject_type", "trigger", "name", "description", "conditions", "actions", "enabled", "default_key", "created_by", "updated_by")
  select install_default_rules.tenant, x."subject_type", x."trigger", x."name", x."description", x."conditions", x."actions", x."enabled", x."key", null, null
  from "better_supabase"."automation_defaults" x
  where not exists (
    select 1 from "better_supabase"."automations" y where y."tenant_id" = install_default_rules.tenant and y."default_key" = x."key"
  )
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Restores a default automation to what its block ships: trigger, name,
-- description, conditions, actions and whether it is on. Takes the edit
-- permission, or publish when the rule is or becomes enabled.
create or replace function "better_supabase"."reset_default_rule"(id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row "better_supabase"."automations";
  v_default "better_supabase"."automation_defaults";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."automations" x where x."id" = reset_default_rule.id for update;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.read'), false)) then
    raise exception 'No rule you can read has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
  end if;
  select * into v_default from "better_supabase"."automation_defaults" x where x."key" = v_row."default_key";
  if v_default."key" is null then
    raise exception 'No block ships this rule' using errcode = '22023', hint = 'AUTOMATION_NOT_DEFAULT';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (case when (v_row."enabled" or v_default."enabled") then coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.publish'), false) else coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.write'), false) end)) then
    raise exception 'You need % to reset this rule', case when (v_row."enabled" or v_default."enabled") then '''automations.publish''' else '''automations.write''' end using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  update "better_supabase"."automations" x set
    "trigger" = v_default."trigger",
    "name" = v_default."name",
    "description" = v_default."description",
    "conditions" = v_default."conditions",
    "actions" = v_default."actions",
    "enabled" = v_default."enabled",
    "stop_processing" = false,
    "version" = x."version" + 1,
    "updated_by" = auth.uid(),
    "updated_at" = now()
  where x."id" = v_row."id"
  returning * into v_row;
  insert into "better_supabase"."automation_versions" ("rule_id", "version", "tenant_id", "name", "conditions", "actions", "saved_by")
  values (v_row."id", v_row."version", v_row."tenant_id", v_row."name", v_row."conditions", v_row."actions", auth.uid())
  on conflict do nothing;
  perform better_supabase.audit_event(
    event_type => 'automation.updated',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$$;

-- A rule's evaluation log, newest first.
create or replace function "better_supabase"."rule_evaluations_list"(rule uuid, before timestamptz default null, page_size integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select x."tenant_id" into v_tenant from "better_supabase"."automations" x where x."id" = rule_evaluations_list.rule;
  if v_tenant is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'automations.read'), false)) then
    return '[]'::jsonb;
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', y."id"::text, 'organizationId', y."tenant_id", 'ruleId', y."rule_id", 'version', y."version", 'subjectType', y."subject_type", 'subjectId', y."subject_id", 'trigger', y."trigger", 'matched', y."matched", 'results', y."results", 'mode', y."mode", 'evaluatedBy', y."evaluated_by", 'evaluatedAt', y."evaluated_at") order by y."evaluated_at" desc, y."id" desc), '[]'::jsonb)
    from (
      select * from "better_supabase"."automation_evaluations" x
      where x."rule_id" = rule_evaluations_list.rule
        and (rule_evaluations_list.before is null or x."evaluated_at" < rule_evaluations_list.before)
      order by x."evaluated_at" desc, x."id" desc
      limit least(greatest(coalesce(rule_evaluations_list.page_size, 50), 1), 200)
    ) y
  );
end;
$$;

revoke execute on function "better_supabase"."rule_text"(jsonb) from public;
grant execute on function "better_supabase"."rule_text"(jsonb) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_numeric"(jsonb) from public;
grant execute on function "better_supabase"."rule_numeric"(jsonb) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_boolean"(jsonb) from public;
grant execute on function "better_supabase"."rule_boolean"(jsonb) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_list"(jsonb) from public;
grant execute on function "better_supabase"."rule_list"(jsonb) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_moment"(text, jsonb) from public;
grant execute on function "better_supabase"."rule_moment"(text, jsonb) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_bounds"(text, jsonb, text, timestamptz) from public;
grant execute on function "better_supabase"."rule_bounds"(text, jsonb, text, timestamptz) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_date"(text, text, jsonb, jsonb, text, timestamptz) from public;
grant execute on function "better_supabase"."rule_date"(text, text, jsonb, jsonb, text, timestamptz) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_equal"(text, jsonb, jsonb) from public;
grant execute on function "better_supabase"."rule_equal"(text, jsonb, jsonb) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_positive"(text, text, text, jsonb, jsonb, text, timestamptz) from public;
grant execute on function "better_supabase"."rule_positive"(text, text, text, jsonb, jsonb, text, timestamptz) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_node"(jsonb, jsonb, jsonb, text, timestamptz) from public;
grant execute on function "better_supabase"."rule_node"(jsonb, jsonb, jsonb, text, timestamptz) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_evaluate"(jsonb, jsonb, jsonb, text, timestamptz) from public;
grant execute on function "better_supabase"."rule_evaluate"(jsonb, jsonb, jsonb, text, timestamptz) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_matches"(jsonb, jsonb, jsonb, text, timestamptz) from public;
grant execute on function "better_supabase"."rule_matches"(jsonb, jsonb, jsonb, text, timestamptz) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_check"(jsonb, jsonb, integer) from public;
grant execute on function "better_supabase"."rule_check"(jsonb, jsonb, integer) to anon, authenticated, service_role;
revoke execute on function "better_supabase"."rule_fields_list"(text) from public, anon;
grant execute on function "better_supabase"."rule_fields_list"(text) to authenticated, service_role;
revoke execute on function "better_supabase"."rule_field_map"(text) from public, anon;
grant execute on function "better_supabase"."rule_field_map"(text) to authenticated, service_role;
revoke execute on function "better_supabase"."upsert_rule"(uuid, jsonb) from public, anon;
grant execute on function "better_supabase"."upsert_rule"(uuid, jsonb) to authenticated, service_role;
revoke execute on function "better_supabase"."rules_list"(uuid, text, text, boolean) from public, anon;
grant execute on function "better_supabase"."rules_list"(uuid, text, text, boolean) to authenticated, service_role;
revoke execute on function "better_supabase"."rule_get"(uuid) from public, anon;
grant execute on function "better_supabase"."rule_get"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."rule_versions_list"(uuid) from public, anon;
grant execute on function "better_supabase"."rule_versions_list"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."set_rule_enabled"(uuid, boolean) from public, anon;
grant execute on function "better_supabase"."set_rule_enabled"(uuid, boolean) to authenticated, service_role;
revoke execute on function "better_supabase"."rank_rule"(uuid, text) from public, anon;
grant execute on function "better_supabase"."rank_rule"(uuid, text) to authenticated, service_role;
revoke execute on function "better_supabase"."delete_rule"(uuid) from public, anon;
grant execute on function "better_supabase"."delete_rule"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."reset_default_rule"(uuid) from public, anon;
grant execute on function "better_supabase"."reset_default_rule"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."matching_rules"(uuid, text, text, jsonb, text) from public, anon;
grant execute on function "better_supabase"."matching_rules"(uuid, text, text, jsonb, text) to authenticated, service_role;
revoke execute on function "better_supabase"."record_rule_evaluation"(uuid, text, boolean, jsonb, text) from public, anon;
grant execute on function "better_supabase"."record_rule_evaluation"(uuid, text, boolean, jsonb, text) to authenticated, service_role;
revoke execute on function "better_supabase"."rule_evaluations_list"(uuid, timestamptz, integer) from public, anon;
grant execute on function "better_supabase"."rule_evaluations_list"(uuid, timestamptz, integer) to authenticated, service_role;
revoke execute on function "better_supabase"."sync_rule_fields"(text, jsonb) from public, anon, authenticated;
grant execute on function "better_supabase"."sync_rule_fields"(text, jsonb) to service_role;
revoke execute on function "better_supabase"."run_rules"(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function "better_supabase"."run_rules"(uuid, text, text, text, jsonb, text) to service_role;
revoke execute on function "better_supabase"."install_default_rules"(uuid) from public, anon, authenticated;
grant execute on function "better_supabase"."install_default_rules"(uuid) to service_role;

-- Row audit for the module's tables (blocks.audit.options.blockTables)
create constraint trigger bsb_audit after insert or update or delete on better_supabase.automations deferrable initially deferred for each row when (better_supabase.import_run() is null or current_setting('better_supabase.import_audit', true) is distinct from 'summary') execute function better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"automation","event_prefix":"automation"}');
