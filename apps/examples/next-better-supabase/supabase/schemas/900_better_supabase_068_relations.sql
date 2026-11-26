-- better-supabase module: relations
-- @bsb-block relations@1 managed
-- @bsb-hash sha256:29fde8e21a980ada626533616c832b9361df90c56fea16987a88d6f873f45dc7
-- Typed links between subjects (blocks, parent, relates, or your own kinds), with inverse names, cycle checks, one-target kinds, walks and rollups.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create table "better_supabase"."relations" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid not null,
  "kind" text not null,
  "source_type" text not null,
  "source_id" text not null,
  "target_type" text not null,
  "target_id" text not null,
  "data" jsonb not null default '{}'::jsonb constraint bsb_relations_data_check check (jsonb_typeof("data") = 'object' and pg_column_size("data") <= 8192),
  "created_by" uuid,
  "created_at" timestamptz not null default now(),
  unique ("tenant_id", "kind", "source_type", "source_id", "target_type", "target_id"),
  constraint bsb_relations_check check (not ("source_type" = "target_type" and "source_id" = "target_id"))
);
create index relations_target_idx on "better_supabase"."relations" ("tenant_id", "target_type", "target_id", "kind");
create index relations_source_idx on "better_supabase"."relations" ("tenant_id", "source_type", "source_id", "kind");
alter table "better_supabase"."relations" enable row level security;
revoke all on "better_supabase"."relations" from public, anon, authenticated;
grant select on "better_supabase"."relations" to authenticated;
grant all on "better_supabase"."relations" to service_role;

create policy bsb_relations_read on "better_supabase"."relations"
  for select to authenticated
  using ("tenant_id" in (select better_supabase.tenant_ids_with('relations.read')));

-- Links two subjects. An inverse name (blocked_by) stores the link from the
-- other end. Acyclic kinds take an advisory lock per tenant and kind, then
-- refuse a link whose target already reaches its source.

create or replace function "better_supabase"."link"(tenant uuid, kind text, source_type text, source_id text, target_type text, target_id text, data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_kind text;
  v_inverted boolean;
  v_acyclic boolean;
  v_single boolean;
  v_symmetric boolean;
  v_source_type text;
  v_source_id text;
  v_target_type text;
  v_target_id text;
  v_id uuid;
  v_created boolean := false;
  v_previous jsonb;
  v_replaced jsonb;
  v_old "better_supabase"."relations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (auth.role() = 'service_role' or coalesce(better_supabase.can('tenant', link.tenant, 'relations.manage'), false)) then
    raise exception 'not allowed to link records' using errcode = '42501', hint = 'RELATION_FORBIDDEN';
  end if;
  if link.data is not null and jsonb_typeof(link.data) <> 'object' then
    raise exception 'data must be an object' using errcode = '22023', hint = 'RELATION_INVALID';
  end if;
  if link.source_type = link.target_type and link.source_id = link.target_id then
    raise exception 'a record can''t link to itself' using errcode = '22023', hint = 'RELATION_SELF';
  end if;

  select k.canonical, k.inverted, k.acyclic, k.single, k.both_ways
    into v_kind, v_inverted, v_acyclic, v_single, v_symmetric
    from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = link.kind;
  if v_kind is null then
    raise exception 'unknown relation kind' using errcode = '22023', hint = 'RELATION_KIND_UNKNOWN';
  end if;
  if v_inverted then
    v_source_type := link.target_type; v_source_id := link.target_id;
    v_target_type := link.source_type; v_target_id := link.source_id;
  else
    v_source_type := link.source_type; v_source_id := link.source_id;
    v_target_type := link.target_type; v_target_id := link.target_id;
  end if;
  if v_symmetric and (v_source_type, v_source_id) > (v_target_type, v_target_id) then
    select v_target_type, v_target_id, v_source_type, v_source_id
      into v_source_type, v_source_id, v_target_type, v_target_id;
  end if;
  if not (true)
     or not (true) then
    raise exception 'not allowed to link these records' using errcode = '42501', hint = 'RELATION_SUBJECT_FORBIDDEN';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_relation_link"(uuid, text, text, text, text, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text)', v_hook::oid::regproc)
        using link.tenant, v_kind, v_source_type, v_source_id, v_target_type, v_target_id;
    end if;
  end;
  if v_acyclic or v_single then
    perform pg_advisory_xact_lock(hashtext(link.tenant::text || ':relation:' || v_kind));
  end if;
  select "id", "data" into v_id, v_previous from "better_supabase"."relations"
    where "tenant_id" = link.tenant and "kind" = v_kind
      and "source_type" = v_source_type and "source_id" = v_source_id
      and "target_type" = v_target_type and "target_id" = v_target_id;
  if v_id is null then
    if v_acyclic and exists (
      with recursive reach(t, i, depth) as (
        select v_target_type, v_target_id, 0
        union
        select r."target_type", r."target_id", reach.depth + 1
        from "better_supabase"."relations" r join reach
          on r."source_type" = reach.t and r."source_id" = reach.i
        where r."tenant_id" = link.tenant and r."kind" = v_kind and reach.depth < 1000
      )
      select 1 from reach where t = v_source_type and i = v_source_id
    ) then
      raise exception 'this link would create a cycle' using errcode = '23514', hint = 'RELATION_CYCLE';
    end if;
    if v_single then
      delete from "better_supabase"."relations"
        where "tenant_id" = link.tenant and "kind" = v_kind
          and "source_type" = v_source_type and "source_id" = v_source_id
        returning * into v_old;
      if v_old."id" is not null then
        v_replaced := jsonb_build_object('targetType', v_old."target_type", 'targetId', v_old."target_id", 'data', v_old."data");
        null;
      end if;
    end if;
    insert into "better_supabase"."relations" ("tenant_id", "kind", "source_type", "source_id", "target_type", "target_id", "data", "created_by")
    values (link.tenant, v_kind, v_source_type, v_source_id, v_target_type, v_target_id, coalesce(link.data, '{}'::jsonb), auth.uid())
    returning "id" into v_id;
    v_created := true;
    null;
  elsif link.data is not null then
    update "better_supabase"."relations" set "data" = link.data where "id" = v_id;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_relation_link"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_id;
    end if;
  end;
  return jsonb_build_object(
    'id', v_id, 'kind', v_kind, 'created', v_created,
    'sourceType', v_source_type, 'sourceId', v_source_id,
    'targetType', v_target_type, 'targetId', v_target_id,
    'previousData', case when v_created then null else v_previous end,
    'replaced', v_replaced);
end;
$$;
revoke execute on function "better_supabase"."link"(uuid, text, text, text, text, text, jsonb) from public, anon;
grant execute on function "better_supabase"."link"(uuid, text, text, text, text, text, jsonb) to authenticated, service_role;

create or replace function "better_supabase"."unlink"(tenant uuid, kind text, source_type text, source_id text, target_type text, target_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_kind text;
  v_inverted boolean;
  v_acyclic boolean;
  v_single boolean;
  v_symmetric boolean;
  v_source_type text;
  v_source_id text;
  v_target_type text;
  v_target_id text;
  v_old "better_supabase"."relations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (auth.role() = 'service_role' or coalesce(better_supabase.can('tenant', unlink.tenant, 'relations.manage'), false)) then
    raise exception 'not allowed to unlink records' using errcode = '42501', hint = 'RELATION_FORBIDDEN';
  end if;

  select k.canonical, k.inverted, k.acyclic, k.single, k.both_ways
    into v_kind, v_inverted, v_acyclic, v_single, v_symmetric
    from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = unlink.kind;
  if v_kind is null then
    raise exception 'unknown relation kind' using errcode = '22023', hint = 'RELATION_KIND_UNKNOWN';
  end if;
  if v_inverted then
    v_source_type := unlink.target_type; v_source_id := unlink.target_id;
    v_target_type := unlink.source_type; v_target_id := unlink.source_id;
  else
    v_source_type := unlink.source_type; v_source_id := unlink.source_id;
    v_target_type := unlink.target_type; v_target_id := unlink.target_id;
  end if;
  if v_symmetric and (v_source_type, v_source_id) > (v_target_type, v_target_id) then
    select v_target_type, v_target_id, v_source_type, v_source_id
      into v_source_type, v_source_id, v_target_type, v_target_id;
  end if;
  if not (true)
     or not (true) then
    raise exception 'not allowed to unlink these records' using errcode = '42501', hint = 'RELATION_SUBJECT_FORBIDDEN';
  end if;
  delete from "better_supabase"."relations"
    where "tenant_id" = unlink.tenant and "kind" = v_kind
      and "source_type" = v_source_type and "source_id" = v_source_id
      and "target_type" = v_target_type and "target_id" = v_target_id
    returning * into v_old;
  if v_old."id" is null then
    return jsonb_build_object('removed', false, 'data', null);
  end if;
  null;
  return jsonb_build_object('removed', true, 'data', v_old."data");
end;
$$;
revoke execute on function "better_supabase"."unlink"(uuid, text, text, text, text, text) from public, anon;
grant execute on function "better_supabase"."unlink"(uuid, text, text, text, text, text) to authenticated, service_role;

-- A subject's links in both directions, each named from the subject's side.
create or replace function "better_supabase"."relations_of"(tenant uuid, subject_type text, subject_id text, kind text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'kind', n.seen, 'direction', e.direction,
    'type', e.other_type, 'subjectId', e.other_id,
    'data', e.data, 'createdAt', e.created_at
  ) order by n.seen, e.created_at, e.id), '[]'::jsonb)
  from (
    select r."id" as id, r."kind" as canonical, 'out' as direction,
      r."target_type" as other_type, r."target_id" as other_id, r."data" as data, r."created_at" as created_at
    from "better_supabase"."relations" r
    where r."tenant_id" = relations_of.tenant and r."source_type" = relations_of.subject_type and r."source_id" = relations_of.subject_id
    union all
    select r."id", r."kind", 'in', r."source_type", r."source_id", r."data", r."created_at"
    from "better_supabase"."relations" r
    where r."tenant_id" = relations_of.tenant and r."target_type" = relations_of.subject_type and r."target_id" = relations_of.subject_id
  ) e
  cross join lateral (
    select case when e.direction = 'in' and not k.both_ways then k.opposite else k.canonical end as seen
    from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite)
    where k.name = e.canonical
  ) n
  where relations_of.kind is null or n.seen = relations_of.kind
$$;
revoke execute on function "better_supabase"."relations_of"(uuid, text, text, text) from public, anon;
grant execute on function "better_supabase"."relations_of"(uuid, text, text, text) to authenticated, service_role;

-- Every link of one kind in a tenant, for a Gantt chart or a tree.
create or replace function "better_supabase"."relations_by_kind"(tenant uuid, kind text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r."id", 'kind', r."kind",
    'sourceType', r."source_type", 'sourceId', r."source_id",
    'targetType', r."target_type", 'targetId', r."target_id",
    'data', r."data"
  ) order by r."created_at", r."id"), '[]'::jsonb)
  from (
    select * from "better_supabase"."relations" r
    where r."tenant_id" = relations_by_kind.tenant
      and r."kind" = (select k.canonical from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = relations_by_kind.kind)
    order by r."created_at", r."id"
    limit 10000
  ) r
$$;
revoke execute on function "better_supabase"."relations_by_kind"(uuid, text) from public, anon;
grant execute on function "better_supabase"."relations_by_kind"(uuid, text) to authenticated, service_role;

-- Every record a subject reaches through links of one kind, with its depth.
-- up follows source to target (a parent's parents); down follows target to source.
create or replace function "better_supabase"."relation_walk"(tenant uuid, kind text, subject_type text, subject_id text, up boolean, max_depth integer)
returns table (type text, id text, depth integer)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_kind text;
  v_inverted boolean;
  v_up boolean;
begin
  select k.canonical, k.inverted into v_kind, v_inverted from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = relation_walk.kind;
  if v_kind is null then
    raise exception 'unknown relation kind' using errcode = '22023', hint = 'RELATION_KIND_UNKNOWN';
  end if;
  v_up := relation_walk.up <> v_inverted;
  return query
  with recursive walk(t, i, d) as (
    select relation_walk.subject_type, relation_walk.subject_id, 0
    union
    select case when v_up then r."target_type" else r."source_type" end,
      case when v_up then r."target_id" else r."source_id" end,
      walk.d + 1
    from "better_supabase"."relations" r join walk on (
      case when v_up then r."source_type" = walk.t and r."source_id" = walk.i
      else r."target_type" = walk.t and r."target_id" = walk.i end)
    where r."tenant_id" = relation_walk.tenant and r."kind" = v_kind
      and walk.d < least(coalesce(relation_walk.max_depth, 100), 100)
  )
  select w.t, w.i, min(w.d)::integer from walk w where w.d > 0
  group by w.t, w.i
  order by min(w.d), w.t, w.i;
end;
$$;
revoke execute on function "better_supabase"."relation_walk"(uuid, text, text, text, boolean, integer) from public, anon;
grant execute on function "better_supabase"."relation_walk"(uuid, text, text, text, boolean, integer) to authenticated, service_role;

create or replace function "better_supabase"."ancestors"(tenant uuid, kind text, subject_type text, subject_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('type', w.type, 'id', w.id, 'depth', w.depth) order by w.depth, w.type, w.id), '[]'::jsonb)
  from "better_supabase"."relation_walk"(ancestors.tenant, ancestors.kind, ancestors.subject_type, ancestors.subject_id, true, null) w
$$;
revoke execute on function "better_supabase"."ancestors"(uuid, text, text, text) from public, anon;
grant execute on function "better_supabase"."ancestors"(uuid, text, text, text) to authenticated, service_role;

create or replace function "better_supabase"."descendants"(tenant uuid, kind text, subject_type text, subject_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('type', w.type, 'id', w.id, 'depth', w.depth) order by w.depth, w.type, w.id), '[]'::jsonb)
  from "better_supabase"."relation_walk"(descendants.tenant, descendants.kind, descendants.subject_type, descendants.subject_id, false, null) w
$$;
revoke execute on function "better_supabase"."descendants"(uuid, text, text, text) from public, anon;
grant execute on function "better_supabase"."descendants"(uuid, text, text, text) to authenticated, service_role;

-- The record of into_type an origin was already converted into: the source
-- of a created_from link whose target is the origin. Conversions call it
-- first, so converting the same deal twice returns the first quote.
create or replace function "better_supabase"."converted_into"(tenant uuid, origin_type text, origin_id text, into_type text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select r."source_id"
  from "better_supabase"."relations" r
  where r."tenant_id" = converted_into.tenant
    and r."kind" = (select k.canonical from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = 'created_from')
    and r."target_type" = converted_into.origin_type and r."target_id" = converted_into.origin_id
    and r."source_type" = converted_into.into_type
  order by r."created_at", r."id"
  limit 1
$$;
revoke execute on function "better_supabase"."converted_into"(uuid, text, text, text) from public, anon;
grant execute on function "better_supabase"."converted_into"(uuid, text, text, text) to authenticated, service_role;

-- Aggregates a column over a subject's descendants of one type, such as the
-- sum of estimates under an epic. Runs as the caller, so the subject table's
-- policies decide which rows count. agg is count, sum, avg, min or max.
create or replace function "better_supabase"."relation_rollup"(tenant uuid, kind text, subject_type text, subject_id text, of_type text, column_name text, agg text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_table text;
  v_id_col text;
  v_tenant_col text;
  v_ids text[];
  v_result jsonb;
begin
  if relation_rollup.agg is null or relation_rollup.agg not in ('count', 'sum', 'avg', 'min', 'max') then
    raise exception 'agg must be count, sum, avg, min or max' using errcode = '22023', hint = 'RELATION_ROLLUP_INVALID';
  end if;
  if relation_rollup.agg <> 'count' and relation_rollup.column_name is null then
    raise exception 'this aggregate needs a column' using errcode = '22023', hint = 'RELATION_ROLLUP_INVALID';
  end if;
  
  if v_table is null then
    raise exception 'this subject type has no table' using errcode = '22023', hint = 'RELATION_SUBJECT_UNKNOWN';
  end if;
  select array_agg(w.id) into v_ids
  from "better_supabase"."relation_walk"(relation_rollup.tenant, relation_rollup.kind, relation_rollup.subject_type, relation_rollup.subject_id, false, null) w
  where w.type = relation_rollup.of_type;
  execute format(
    'select to_jsonb(%s) from %s s where s.%I::text = any ($1)%s',
    case when relation_rollup.agg = 'count' and relation_rollup.column_name is null then 'count(*)'
      else format('%s(s.%I)', relation_rollup.agg, relation_rollup.column_name) end,
    v_table,
    v_id_col,
    case when v_tenant_col is null then '' else format(' and s.%I = $2', v_tenant_col) end
  ) into v_result using coalesce(v_ids, '{}'::text[]), relation_rollup.tenant;
  return v_result;
end;
$$;
revoke execute on function "better_supabase"."relation_rollup"(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function "better_supabase"."relation_rollup"(uuid, text, text, text, text, text, text) to authenticated, service_role;

-- Tenant isolation (ADR 0099): permissive policies combine with or, so one
-- the app adds would widen the block's. These restrictive policies keep each
-- table to the caller's organizations and what the block's policies grant.
create policy bsb_tenant_scope_select on "better_supabase"."relations" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('relations.read')))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."relations" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."relations" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."relations" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));

-- Row audit for the module's tables (blocks.audit.options.blockTables)
create constraint trigger bsb_audit after insert or update or delete on better_supabase.relations deferrable initially deferred for each row when (better_supabase.import_run() is null or current_setting('better_supabase.import_audit', true) is distinct from 'summary') execute function better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"relation","event_prefix":"relation"}');
