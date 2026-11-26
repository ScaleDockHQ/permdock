-- better-supabase module: usage
-- @bsb-block usage@9 managed
-- @bsb-hash sha256:8c48889e5f21a47ccbc0ae2a946d59ad5851c4c25b96e06d901f44016c882332
-- Usage counters per tenant, meter and day with idempotent increments, quotas per tenant or plan, within_quota() for policies and consume_quota(), which raises quota_exceeded. unreported_usage() feeds reportUsageToStripe.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

-- Usage per tenant, meter and UTC day. Quotas sum the days of their period.
create table "better_supabase"."usage_counters" (
  "tenant_id" uuid not null,
  "meter" text not null constraint bsb_usage_counters_meter_check check ("meter" ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  "day" date not null,
  "value" numeric not null default 0 constraint bsb_usage_counters_value_check check ("value" >= 0),
  "reported_value" numeric not null default 0 constraint bsb_usage_counters_reported_value_check check ("reported_value" >= 0),
  "updated_at" timestamptz not null default now(),
  primary key ("tenant_id", "meter", "day")
);
-- Quantities are numeric, so a meter can count fractions (GB-hours, credits).
alter table "better_supabase"."usage_counters" alter column "value" type numeric;
alter table "better_supabase"."usage_counters" alter column "reported_value" type numeric;
create index usage_counters_unreported_idx on "better_supabase"."usage_counters" ("day")
  where "value" > "reported_value";
alter table "better_supabase"."usage_counters" enable row level security;
revoke all on "better_supabase"."usage_counters" from public, anon, authenticated;
grant select on "better_supabase"."usage_counters" to authenticated;
grant all on "better_supabase"."usage_counters" to service_role;
create policy bsb_usage_counters_read on "better_supabase"."usage_counters"
  for select to authenticated
  using ("tenant_id" in (select better_supabase.tenant_ids_with('usage.read')));

-- One row per idempotency key, so a retried increment counts once.
create table "better_supabase"."usage_events" (
  "tenant_id" uuid not null,
  "meter" text not null,
  "idempotency_key" text not null,
  "quantity" numeric not null,
  "recorded_at" timestamptz not null default now(),
  primary key ("tenant_id", "meter", "idempotency_key")
);
alter table "better_supabase"."usage_events" alter column "quantity" type numeric;

create index usage_events_recorded_at_idx on "better_supabase"."usage_events" ("recorded_at");
alter table "better_supabase"."usage_events" enable row level security;
revoke all on "better_supabase"."usage_events" from public, anon, authenticated;
grant all on "better_supabase"."usage_events" to service_role;

-- A tenant row overrides the plan rows; of several plan rows the highest
-- limit wins. A null limit is unlimited, so it wins over every limit.
create table "better_supabase"."usage_quotas" (
  "id" uuid primary key default gen_random_uuid(),
  "tenant_id" uuid,
  "plan" text,
  "meter" text not null constraint bsb_usage_quotas_meter_check check ("meter" ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  "limit" numeric constraint bsb_usage_quotas_limit_check check ("limit" >= 0),
  "period" text not null default 'month' constraint bsb_usage_quotas_period_check check ("period" in ('day', 'week', 'month', 'year', 'billing')),
  "created_at" timestamptz not null default now(),
  constraint bsb_usage_quotas_check check (("tenant_id" is null) <> ("plan" is null)),
  unique nulls not distinct ("tenant_id", "plan", "meter")
);
alter table "better_supabase"."usage_quotas" alter column "limit" type numeric;
alter table "better_supabase"."usage_quotas" alter column "limit" drop not null;
alter table "better_supabase"."usage_quotas" enable row level security;
revoke all on "better_supabase"."usage_quotas" from public, anon, authenticated;
grant select on "better_supabase"."usage_quotas" to authenticated;
grant all on "better_supabase"."usage_quotas" to service_role;
create policy bsb_usage_quotas_read on "better_supabase"."usage_quotas"
  for select to authenticated
  using ("tenant_id" is null or "tenant_id" in (select better_supabase.tenant_ids_with('usage.read')));

-- The bigint signatures and return types before quantities were numeric.

-- The signatures before usage carried a source, metadata and actor.

-- The signature before the report could skip meters and tenants.


-- The quota that applies to each pair of tenants and meters that has one. It
-- resolves each distinct tenant's plans once, then picks a quota per pair in
-- the order usage_quota uses: the tenant's own row, then the highest plan
-- limit, where a null (unlimited) limit is highest. A tenant's entitlements
-- and plans are read only when a plan quota on these meters exists, as
-- usage_quota did before.
create or replace function "better_supabase"."usage_quotas_for"(tenants uuid[], meters text[])
returns table (tenant uuid, meter text, quota_limit numeric, period text)
language sql
stable
security definer
set search_path = ''
as $$
  with t as materialized (
    select d.tenant, case when exists (select 1 from "better_supabase"."usage_quotas" pq where pq."meter" = any (usage_quotas_for.meters) and pq."tenant_id" is null and pq."plan" <> '*') then better_supabase.tenant_entitlements(d.tenant)::text[] end as entitled
    from (select distinct u.tenant from unnest(usage_quotas_for.tenants) u(tenant) where u.tenant is not null) d
  )
  select distinct on (t.tenant, q."meter") t.tenant, q."meter", q."limit", q."period"
  from t
  join "better_supabase"."usage_quotas" q on q."meter" = any (usage_quotas_for.meters)
    and (q."tenant_id" = t.tenant or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any (t.entitled))))
  order by t.tenant, q."meter", (q."tenant_id" is not null) desc, q."limit" desc nulls first
$$;

-- The quota that applies to tenant and meter, or no row. An unlimited quota
-- is a row with a null quota_limit.
create or replace function "better_supabase"."usage_quota"(tenant uuid, meter text)
returns table (quota_limit numeric, period text)
language sql
stable
security invoker
set search_path = ''
as $$
  select q.quota_limit, q.period
  from "better_supabase"."usage_quotas_for"(array[usage_quota.tenant], array[usage_quota.meter]) q
$$;

-- Sets the quota of one tenant or one plan (exactly one of them) on a meter;
-- a null quota_limit is unlimited. A tenant quota overrides the plan's.
create or replace function "better_supabase"."set_usage_quota"(
  tenant uuid,
  plan text,
  meter text,
  quota_limit numeric,
  period text default 'month'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  changed integer;
begin
  if (tenant is null) = (plan is null) then
    raise exception 'set_usage_quota needs a tenant or a plan, not both' using errcode = '22023', hint = 'USAGE_QUOTA_TARGET';
  end if;
  update "better_supabase"."usage_quotas" q
  set "limit" = quota_limit, "period" = coalesce(period, 'month')
  where q."meter" = meter
    and q."tenant_id" is not distinct from tenant
    and q."plan" is not distinct from plan;
  if not found then
    insert into "better_supabase"."usage_quotas" ("tenant_id", "plan", "meter", "limit", "period")
    values (tenant, plan, meter, quota_limit, coalesce(period, 'month'));
  end if;
end
$$;

-- Removes the quota of one tenant or plan on a meter; true when there was one.
create or replace function "better_supabase"."remove_usage_quota"(tenant uuid, plan text, meter text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
begin
  if (tenant is null) = (plan is null) then
    raise exception 'remove_usage_quota needs a tenant or a plan, not both' using errcode = '22023', hint = 'USAGE_QUOTA_TARGET';
  end if;
  delete from "better_supabase"."usage_quotas" q
  where q."meter" = meter
    and q."tenant_id" is not distinct from tenant
    and q."plan" is not distinct from plan;
  return found;
end
$$;

-- The window of a period for tenant: the current UTC day, week, month or
-- year, or with 'billing' the app's usage_billing_period(tenant) (the
-- subscription's current period, say), falling back to the month.
create or replace function "better_supabase"."usage_window"(tenant uuid, period text default 'month')
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period text := coalesce(usage_window.period, 'month');
  v_start timestamptz;
  v_end timestamptz;
begin
  if v_period = 'billing' then
    if to_regprocedure('"public"."usage_billing_period"(uuid)') is not null then
      -- Not a literal name, so plpgsql_check passes without the hook.
      execute format('select h.starts_at, h.ends_at from %s($1) h', to_regprocedure('"public"."usage_billing_period"(uuid)')::oid::regproc)
        into v_start, v_end using usage_window.tenant;
    end if;
    if v_start is null or v_end is null or v_end <= v_start then
      v_period := 'month';
      v_start := null;
    end if;
  end if;
  if v_start is null then
    v_start := date_trunc(v_period, now() at time zone 'utc') at time zone 'utc';
    v_end := v_start + ('1 ' || v_period)::interval;
  end if;
  return query select v_start, v_end;
end;
$$;

-- The first UTC day of the window of period that holds day, which can be
-- in an earlier window than now. Earlier billing periods are assumed to be as
-- long as the current one; past 120 of them it falls back to the month.
create or replace function "better_supabase"."usage_window_start"(tenant uuid, period text, day date)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_length interval;
  v_steps integer := 0;
begin
  if usage_window_start.period is null then
    return usage_window_start.day;
  end if;
  if usage_window_start.period <> 'billing' then
    return date_trunc(usage_window_start.period, usage_window_start.day)::date;
  end if;
  select w.starts_at, w.ends_at into v_start, v_end
  from "better_supabase"."usage_window"(usage_window_start.tenant, 'billing') w;
  v_length := age(v_end, v_start);
  while usage_window_start.day < (v_start at time zone 'utc')::date and v_steps < 120 loop
    v_start := v_start - v_length;
    v_steps := v_steps + 1;
  end loop;
  if usage_window_start.day < (v_start at time zone 'utc')::date then
    return date_trunc('month', usage_window_start.day)::date;
  end if;
  return (v_start at time zone 'utc')::date;
end;
$$;

-- Usage of meter in the current window of period, counted by UTC day.
create or replace function "better_supabase"."usage_used"(tenant uuid, meter text, period text default 'month')
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(c."value"), 0)::numeric
  from "better_supabase"."usage_counters" c, "better_supabase"."usage_window"(usage_used.tenant, usage_used.period) w
  where c."tenant_id" = usage_used.tenant
    and c."meter" = usage_used.meter
    and c."day" >= (w.starts_at at time zone 'utc')::date
    and c."day" < greatest((w.ends_at at time zone 'utc')::date, (w.starts_at at time zone 'utc')::date + 1)
$$;

-- The meter catalog (options.meters): meter to { unit, category, label }.
create or replace function "better_supabase"."usage_meters"()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{}'::jsonb
$$;

-- { meter, used, limit, remaining, unlimited, period, resets_at, starts_at }.
-- limit and remaining are null without a quota and for an unlimited one. The
-- quota, the window and the used sum are one query. Needs usage.read, like
-- usage_overview.
create or replace function "better_supabase"."usage_status"(tenant uuid, meter text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  return (
    with quota as (
      select q."limit" as quota_limit, q."period" as period
      from "better_supabase"."usage_quotas" q
      where q."meter" = usage_status.meter
        and (q."tenant_id" = usage_status.tenant or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any (better_supabase.tenant_entitlements(tenant)))))
      order by (q."tenant_id" is not null) desc, q."limit" desc nulls first
      limit 1
    ),
    win as (
      select w.starts_at, w.ends_at
      from "better_supabase"."usage_window"(usage_status.tenant, coalesce((select quota.period from quota), 'month')) w
    ),
    used as (
      select coalesce(sum(c."value"), 0)::numeric as used
      from "better_supabase"."usage_counters" c
      cross join win w
      where c."tenant_id" = usage_status.tenant
        and c."meter" = usage_status.meter
        and c."day" >= (w.starts_at at time zone 'utc')::date
        and c."day" < greatest((w.ends_at at time zone 'utc')::date, (w.starts_at at time zone 'utc')::date + 1)
    )
    select jsonb_build_object(
      'meter', usage_status.meter,
      'used', (select used.used from used),
      'limit', (select quota.quota_limit from quota),
      'remaining', case
        when (select quota.quota_limit from quota) is null then null
        else greatest((select quota.quota_limit from quota) - (select used.used from used), 0)
      end,
      'unlimited', (select quota.period from quota) is not null and (select quota.quota_limit from quota) is null,
      'period', coalesce((select quota.period from quota), 'month'),
      'resets_at', (select win.ends_at from win),
      'starts_at', (select win.starts_at from win)
    ) || coalesce("better_supabase"."usage_meters"() -> usage_status.meter, '{}'::jsonb)
  );
end;
$$;

-- { used, limit, remaining, resets_at } for one meter, without the catalog.
create or replace function "better_supabase"."usage_remaining"(tenant uuid, meter text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  return (
    with quota as (
      select q."limit" as quota_limit, q."period" as period
      from "better_supabase"."usage_quotas" q
      where q."meter" = usage_remaining.meter
        and (q."tenant_id" = usage_remaining.tenant or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any (better_supabase.tenant_entitlements(tenant)))))
      order by (q."tenant_id" is not null) desc, q."limit" desc nulls first
      limit 1
    ),
    win as (
      select w.starts_at, w.ends_at
      from "better_supabase"."usage_window"(usage_remaining.tenant, coalesce((select quota.period from quota), 'month')) w
    ),
    used as (
      select coalesce(sum(c."value"), 0)::numeric as used
      from "better_supabase"."usage_counters" c
      cross join win w
      where c."tenant_id" = usage_remaining.tenant
        and c."meter" = usage_remaining.meter
        and c."day" >= (w.starts_at at time zone 'utc')::date
        and c."day" < greatest((w.ends_at at time zone 'utc')::date, (w.starts_at at time zone 'utc')::date + 1)
    )
    select jsonb_build_object(
      'used', (select used.used from used),
      'limit', (select quota.quota_limit from quota),
      'remaining', case
        when (select quota.quota_limit from quota) is null then null
        else greatest((select quota.quota_limit from quota) - (select used.used from used), 0)
      end,
      'resets_at', (select win.ends_at from win)
    )
  );
end;
$$;

-- One row per meter: the tenant's plans and entitlements read once, the quota
-- resolved once, the window once per distinct period, and the counters summed
-- in one grouped join. The catalog is read once.
create or replace function "better_supabase"."usage_overview"(tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  return (
    with scoped as materialized (
      select q.* from "better_supabase"."usage_quotas" q
      where q."tenant_id" = usage_overview.tenant
        or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any ((select better_supabase.tenant_entitlements(usage_overview.tenant))::text[])))
    ),
    meters as (
      select jsonb_object_keys("better_supabase"."usage_meters"()) as meter
      union
      select q."meter" from scoped q
      union
      select distinct c."meter" from "better_supabase"."usage_counters" c
      where c."tenant_id" = usage_overview.tenant
    ),
    quota as (
      select distinct on (q."meter")
        q."meter" as meter,
        q."limit" as quota_limit,
        q."period" as period
      from scoped q
      join meters m on m.meter = q."meter"
      order by q."meter", (q."tenant_id" is not null) desc, q."limit" desc nulls first
    ),
    chosen as (
      select m.meter,
        quota.quota_limit,
        quota.period as quota_period,
        coalesce(quota.period, 'month') as period
      from meters m
      left join quota on quota.meter = m.meter
    ),
    win as (
      select p.period, w.starts_at, w.ends_at
      from (select distinct chosen.period from chosen) p
      cross join lateral "better_supabase"."usage_window"(usage_overview.tenant, p.period) w
    ),
    used as (
      select ch.meter, coalesce(sum(c."value"), 0)::numeric as used
      from chosen ch
      join win w on w.period = ch.period
      left join "better_supabase"."usage_counters" c
        on c."tenant_id" = usage_overview.tenant
        and c."meter" = ch.meter
        and c."day" >= (w.starts_at at time zone 'utc')::date
        and c."day" < greatest((w.ends_at at time zone 'utc')::date, (w.starts_at at time zone 'utc')::date + 1)
      group by ch.meter
    ),
    catalog as (
      select "better_supabase"."usage_meters"() as meters
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'meter', ch.meter,
        'used', u.used,
        'limit', ch.quota_limit,
        'remaining', case
          when ch.quota_limit is null then null
          else greatest(ch.quota_limit - u.used, 0)
        end,
        'unlimited', ch.quota_period is not null and ch.quota_limit is null,
        'period', ch.period,
        'resets_at', w.ends_at,
        'starts_at', w.starts_at
      ) || coalesce(catalog.meters -> ch.meter, '{}'::jsonb)
      order by ch.meter
    ), '[]'::jsonb)
    from chosen ch
    join used u on u.meter = ch.meter
    join win w on w.period = ch.period
    cross join catalog
  );
end;
$$;

-- For policies: whether quantity more fits the tenant's quota. False for a
-- caller outside the tenant, so it can't probe another tenant's usage.
--   with check (better_supabase.within_quota(organization_id, 'projects'))
create or replace function "better_supabase"."within_quota"(tenant uuid, meter text, quantity bigint default 1)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  quota record;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or tenant::text in (select t.id::text from permdock.member_organization_ids() as t(id))) then
    return false;
  end if;
  select * into quota from "better_supabase"."usage_quota"(tenant, meter);
  if quota.quota_limit is null then
    return true;
  end if;
  return "better_supabase"."usage_used"(tenant, meter, quota.period) + quantity <= quota.quota_limit;
end;
$$;

-- Adds quantity once per idempotency key, for usage.record or the service
-- role. Returns { recorded, used, today }: recorded is false for a key seen
-- before, used is the usage in the quota's period and today the UTC day's. With options.history, also keeps
-- who (the caller, or actor for the service role) and what (source,
-- metadata) used it.
create or replace function "better_supabase"."record_usage"(
  tenant uuid,
  meter text,
  quantity numeric default 1,
  idempotency_key text default null,
  source text default null,
  metadata jsonb default null,
  actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  today date := (now() at time zone 'utc')::date;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.record'), false)) then
    raise exception 'Not allowed to record usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  if quantity is null or quantity < 0 then
    raise exception 'quantity must be zero or more' using errcode = '22023', hint = 'USAGE_QUANTITY';
  end if;
  if idempotency_key is not null then
    insert into "better_supabase"."usage_events" ("tenant_id", "meter", "idempotency_key", "quantity")
    values (tenant, meter, idempotency_key, quantity)
    on conflict do nothing;
    if not found then
      return jsonb_build_object('recorded', false, 'used', "better_supabase"."usage_used"(tenant, meter, coalesce((select q.period from "better_supabase"."usage_quota"(tenant, meter) q), 'month')), 'today', "better_supabase"."usage_used"(tenant, meter, 'day'));
    end if;
  end if;
  insert into "better_supabase"."usage_counters" as c ("tenant_id", "meter", "day", "value")
  values (tenant, meter, today, quantity)
  on conflict ("tenant_id", "meter", "day") do update
    set "value" = c."value" + excluded."value", "updated_at" = now();
  return jsonb_build_object('recorded', true, 'used', "better_supabase"."usage_used"(tenant, meter, coalesce((select q.period from "better_supabase"."usage_quota"(tenant, meter) q), 'month')), 'today', "better_supabase"."usage_used"(tenant, meter, 'day'));
end;
$$;

-- Like record_usage, but first checks the quota and raises quota_exceeded
-- (SQLSTATE BSQ29) without recording when quantity does not fit. A transaction
-- lock per tenant and meter, not today's counter row, serializes the calls, so
-- calls on either side of UTC midnight cannot both take the last unit.
create or replace function "better_supabase"."consume_quota"(
  tenant uuid,
  meter text,
  quantity numeric default 1,
  idempotency_key text default null,
  source text default null,
  metadata jsonb default null,
  actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  quota record;
  used numeric;
  win record;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.record'), false)) then
    raise exception 'Not allowed to record usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  perform pg_advisory_xact_lock(hashtext('better_supabase.consume_quota'), hashtext(tenant::text || '/' || meter));
  if idempotency_key is not null and exists (
    select 1 from "better_supabase"."usage_events" e
    where e."tenant_id" = consume_quota.tenant and e."meter" = consume_quota.meter and e."idempotency_key" = consume_quota.idempotency_key
  ) then
    return jsonb_build_object('recorded', false, 'used', "better_supabase"."usage_used"(tenant, meter, coalesce((select q.period from "better_supabase"."usage_quota"(tenant, meter) q), 'month')), 'today', "better_supabase"."usage_used"(tenant, meter, 'day'));
  end if;
  select * into quota from "better_supabase"."usage_quota"(tenant, meter);
  if quota.quota_limit is not null then
    used := "better_supabase"."usage_used"(tenant, meter, quota.period);
    if used + quantity > quota.quota_limit then
      select * into win from "better_supabase"."usage_window"(tenant, quota.period);
      raise exception 'Quota for % exceeded', meter using
        errcode = 'BSQ29',
        hint = 'QUOTA_EXCEEDED',
        detail = jsonb_build_object(
          'meter', meter,
          'limit', quota.quota_limit,
          'used', used,
          'retry_after', greatest(1, ceil(extract(epoch from win.ends_at - now()))::integer)
        )::text;
    end if;
  end if;
  return "better_supabase"."record_usage"(tenant, meter, quantity, idempotency_key, source, metadata, actor);
end;
$$;

-- Records several meters at once, all or none: entries is [{ meter, quantity }],
-- each checked against its quota first when check is true (a quota_exceeded
-- on one records nothing). idempotency_key is per batch. Returns { recorded,
-- used: { meter: usage in its quota period }, today: { meter: today's usage } }.
create or replace function "better_supabase"."record_usage_batch"(
  tenant uuid,
  entries jsonb,
  idempotency_key text default null,
  "check" boolean default false,
  source text default null,
  metadata jsonb default null,
  actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  entry jsonb;
  outcome jsonb;
  recorded boolean := false;
  used jsonb := '{}';
  today_used jsonb := '{}';
begin
  -- A JSON text of the array, as a transport that sends arrays as text passes it.
  if jsonb_typeof(entries) = 'string' then
    entries := (entries #>> '{}')::jsonb;
  end if;
  if jsonb_typeof(entries) <> 'array' or jsonb_array_length(entries) = 0 then
    raise exception 'entries must be a non-empty array of { meter, quantity }' using errcode = '22023', hint = 'USAGE_ENTRIES';
  end if;
  for entry in select value from jsonb_array_elements(entries) loop
    if jsonb_typeof(entry -> 'meter') <> 'string' then
      raise exception 'Every entry needs a meter' using errcode = '22023', hint = 'USAGE_ENTRIES';
    end if;
    if record_usage_batch."check" then
      outcome := "better_supabase"."consume_quota"(tenant, entry ->> 'meter', coalesce((entry ->> 'quantity')::numeric, 1),
        case when idempotency_key is null then null else idempotency_key || ':' || (entry ->> 'meter') end,
        source, metadata, actor);
    else
      outcome := "better_supabase"."record_usage"(tenant, entry ->> 'meter', coalesce((entry ->> 'quantity')::numeric, 1),
        case when idempotency_key is null then null else idempotency_key || ':' || (entry ->> 'meter') end,
        source, metadata, actor);
    end if;
    recorded := recorded or (outcome ->> 'recorded')::boolean;
    used := used || jsonb_build_object(entry ->> 'meter', outcome -> 'used');
    today_used := today_used || jsonb_build_object(entry ->> 'meter', outcome -> 'today');
  end loop;
  return jsonb_build_object('recorded', recorded, 'used', used, 'today', today_used);
end;
$$;

-- Server-side, for reportUsageToStripe: counters with unreported usage, with
-- the quota that includes some of it (included, null without a quota) and the
-- usage of the earlier days of that quota's window (window_before), so the
-- report can send only the overage. skip_meters and skip_tenants leave out
-- counters the report can't send yet, so they don't fill every batch.
create or replace function "better_supabase"."unreported_usage"(
  max_rows integer default 500,
  skip_meters text[] default '{}',
  skip_tenants uuid[] default '{}'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with c as materialized (
    select * from "better_supabase"."usage_counters" c
    where c."value" > c."reported_value"
      and c."meter" <> all (coalesce(unreported_usage.skip_meters, '{}'))
      and c."tenant_id" <> all (coalesce(unreported_usage.skip_tenants, '{}'))
    order by c."day"
    limit max_rows
  ),
  tenants as materialized (
    select t.tenant, better_supabase.tenant_entitlements(t.tenant)::text[] as entitled
    from (select distinct c."tenant_id" as tenant from c) t
  ),
  quota as materialized (
    select distinct on (p.tenant, p.meter) p.tenant, p.meter, q."limit" as quota_limit, q."period" as period
    from (select distinct c."tenant_id" as tenant, c."meter" as meter from c) p
    join tenants t on t.tenant = p.tenant
    join "better_supabase"."usage_quotas" q on q."meter" = p.meter
      and (q."tenant_id" = p.tenant or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any (t.entitled))))
    order by p.tenant, p.meter, (q."tenant_id" is not null) desc, q."limit" desc nulls first
  ),
  win as materialized (
    select d.tenant, d.period, d.day, "better_supabase"."usage_window_start"(d.tenant, d.period, d.day) as since
    from (
      select distinct c."tenant_id" as tenant, q.period, c."day" as day
      from c
      left join quota q on q.tenant = c."tenant_id" and q.meter = c."meter"
    ) d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id', c."tenant_id",
    'meter', c."meter",
    'day', c."day",
    'value', c."value",
    'reported_value', c."reported_value",
    'included', q.quota_limit,
    'unlimited', q.period is not null and q.quota_limit is null,
    'window_before', (
      select coalesce(sum(o."value"), 0)
      from "better_supabase"."usage_counters" o
      where o."tenant_id" = c."tenant_id" and o."meter" = c."meter"
        and o."day" < c."day"
        and o."day" >= w.since
    )
  ) order by c."day", c."meter"), '[]'::jsonb)
  from c
  left join quota q on q.tenant = c."tenant_id" and q.meter = c."meter"
  join win w on w.tenant = c."tenant_id" and w.period is not distinct from q.period and w.day = c."day"
$$;

-- Marks a counter as reported up to value; never moves it backwards.
create or replace function "better_supabase"."mark_usage_reported"(tenant uuid, meter text, day date, value numeric)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update "better_supabase"."usage_counters" c set "reported_value" = greatest(c."reported_value", mark_usage_reported.value)
    where c."tenant_id" = mark_usage_reported.tenant
      and c."meter" = mark_usage_reported.meter
      and c."day" = mark_usage_reported.day
    returning 1
  )
  select exists (select 1 from updated)
$$;

-- A tenant's usage history, newest first, of one meter when given, before
-- before_id for the next page. [] without options.history. Needs usage.read.
create or replace function "better_supabase"."usage_history"(tenant uuid, meter text default null, max_rows integer default 100, before_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  return '[]'::jsonb;
end;
$$;

-- Who and what used a meter in the current window of its quota period:
-- [{ actor, source, quantity }], largest first. [] without options.history.
create or replace function "better_supabase"."usage_breakdown"(tenant uuid, meter text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  quota record;
  win record;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  select * into quota from "better_supabase"."usage_quota"(tenant, meter);
  select * into win from "better_supabase"."usage_window"(tenant, coalesce(quota.period, 'month'));
  return '[]'::jsonb;
end;
$$;

-- Deletes up to batch history rows older than older_than; returns how many.
create or replace function "better_supabase"."purge_usage_history"(older_than interval default '400 days', batch integer default 10000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  return 0;
end;
$$;

-- Deletes up to batch idempotency keys older than older_than; returns how
-- many. A retry with a purged key counts again, so keep them longer than
-- any client retries.
create or replace function "better_supabase"."purge_usage_events"(older_than interval default '30 days', batch integer default 10000)
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from "better_supabase"."usage_events" x
    where (x."tenant_id", x."meter", x."idempotency_key") in (
      select e."tenant_id", e."meter", e."idempotency_key" from "better_supabase"."usage_events" e
      where e."recorded_at" < now() - coalesce(older_than, '30 days')
      order by e."recorded_at" limit coalesce(batch, 10000)
    )
    returning 1
  )
  select count(*)::integer from gone
$$;

revoke execute on function "better_supabase"."usage_history"(uuid, text, integer, bigint) from public, anon;
revoke execute on function "better_supabase"."usage_breakdown"(uuid, text) from public, anon;
revoke execute on function "better_supabase"."purge_usage_history"(interval, integer) from public, anon, authenticated;
grant execute on function "better_supabase"."usage_history"(uuid, text, integer, bigint) to authenticated, service_role;
grant execute on function "better_supabase"."usage_breakdown"(uuid, text) to authenticated, service_role;
grant execute on function "better_supabase"."purge_usage_history"(interval, integer) to service_role;
revoke execute on function "better_supabase"."purge_usage_events"(interval, integer) from public, anon, authenticated;
grant execute on function "better_supabase"."purge_usage_events"(interval, integer) to service_role;
revoke execute on function "better_supabase"."usage_window"(uuid, text) from public, anon, authenticated;
revoke execute on function "better_supabase"."usage_meters"() from public;
grant execute on function "better_supabase"."usage_window"(uuid, text) to service_role;
revoke execute on function "better_supabase"."usage_window_start"(uuid, text, date) from public, anon, authenticated;
grant execute on function "better_supabase"."usage_window_start"(uuid, text, date) to service_role;
grant execute on function "better_supabase"."usage_meters"() to anon, authenticated, service_role;
revoke execute on function "better_supabase"."usage_quota"(uuid, text) from public, anon, authenticated;
revoke execute on function "better_supabase"."usage_used"(uuid, text, text) from public, anon, authenticated;
revoke execute on function "better_supabase"."usage_status"(uuid, text) from public, anon;
revoke execute on function "better_supabase"."usage_remaining"(uuid, text) from public, anon;
revoke execute on function "better_supabase"."usage_overview"(uuid) from public, anon;
grant execute on function "better_supabase"."usage_overview"(uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."within_quota"(uuid, text, bigint) from public, anon;
revoke execute on function "better_supabase"."record_usage"(uuid, text, numeric, text, text, jsonb, uuid) from public, anon;
revoke execute on function "better_supabase"."consume_quota"(uuid, text, numeric, text, text, jsonb, uuid) from public, anon;
revoke execute on function "better_supabase"."record_usage_batch"(uuid, jsonb, text, boolean, text, jsonb, uuid) from public, anon;
grant execute on function "better_supabase"."record_usage_batch"(uuid, jsonb, text, boolean, text, jsonb, uuid) to authenticated, service_role;
revoke execute on function "better_supabase"."unreported_usage"(integer, text[], uuid[]) from public, anon, authenticated;
revoke execute on function "better_supabase"."mark_usage_reported"(uuid, text, date, numeric) from public, anon, authenticated;
grant execute on function "better_supabase"."usage_quota"(uuid, text) to service_role;
revoke execute on function "better_supabase"."usage_quotas_for"(uuid[], text[]) from public, anon, authenticated;
grant execute on function "better_supabase"."usage_quotas_for"(uuid[], text[]) to service_role;
revoke execute on function "better_supabase"."set_usage_quota"(uuid, text, text, numeric, text) from public, anon, authenticated;
revoke execute on function "better_supabase"."remove_usage_quota"(uuid, text, text) from public, anon, authenticated;
grant execute on function "better_supabase"."set_usage_quota"(uuid, text, text, numeric, text) to service_role;
grant execute on function "better_supabase"."remove_usage_quota"(uuid, text, text) to service_role;
grant execute on function "better_supabase"."usage_used"(uuid, text, text) to service_role;
grant execute on function "better_supabase"."usage_status"(uuid, text) to authenticated, service_role;
grant execute on function "better_supabase"."usage_remaining"(uuid, text) to authenticated, service_role;
grant execute on function "better_supabase"."within_quota"(uuid, text, bigint) to authenticated, service_role;
grant execute on function "better_supabase"."record_usage"(uuid, text, numeric, text, text, jsonb, uuid) to authenticated, service_role;
grant execute on function "better_supabase"."consume_quota"(uuid, text, numeric, text, text, jsonb, uuid) to authenticated, service_role;
grant execute on function "better_supabase"."unreported_usage"(integer, text[], uuid[]) to service_role;
grant execute on function "better_supabase"."mark_usage_reported"(uuid, text, date, numeric) to service_role;

-- Tenant isolation (ADR 0099): permissive policies combine with or, so one
-- the app adds would widen the block's. These restrictive policies keep each
-- table to the caller's organizations and what the block's policies grant.
create policy bsb_tenant_scope_select on "better_supabase"."usage_counters" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" in (select better_supabase.tenant_ids_with('usage.read')))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."usage_counters" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."usage_counters" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."usage_counters" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_select on "better_supabase"."usage_quotas" as restrictive
  for select to public
  using (
    "tenant_id" in (select better_supabase.member_organization_ids())
    or ("tenant_id" is null or "tenant_id" in (select better_supabase.tenant_ids_with('usage.read')))
  );
create policy bsb_tenant_scope_insert on "better_supabase"."usage_quotas" as restrictive
  for insert to public
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_update on "better_supabase"."usage_quotas" as restrictive
  for update to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()))
  with check ("tenant_id" in (select better_supabase.member_organization_ids()));
create policy bsb_tenant_scope_delete on "better_supabase"."usage_quotas" as restrictive
  for delete to public
  using ("tenant_id" in (select better_supabase.member_organization_ids()));
