-- better-supabase module: housekeeping
-- @bsb-block housekeeping@1 managed
-- @bsb-hash sha256:c50299dd8c5c5eda8b5b1276ab041d899c0fb6380a839dcfb438644abfe2ef9b
-- One dispatcher for the recurring cleanups the installed blocks contribute (purges, expiries): maintenance() runs each due job and records its outcome, and maintenance_schedule() registers it with pg_cron.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

-- One row per job the dispatcher ran: when, with what result, and how often.
create table "better_supabase"."maintenance_state" (
  "job" text primary key,
  "last_run_at" timestamptz,
  "last_status" text constraint bsb_maintenance_state_last_status_check check ("last_status" in ('ok', 'error')),
  "last_result" jsonb,
  "last_error" text,
  "runs" bigint not null default 0
);
alter table "better_supabase"."maintenance_state" enable row level security;
revoke all on "better_supabase"."maintenance_state" from public, anon, authenticated;
grant all on "better_supabase"."maintenance_state" to service_role;

-- The jobs the installed blocks contribute, with when each last ran and
-- whether it is due. Rendered from the blocks' `housekeeping` contributions.
create or replace view "better_supabase"."maintenance_jobs" with (security_invoker = true) as
  select j.job, j.fn as function, j.every_interval as every,
  s."last_run_at" as last_run_at, s."last_status" as last_status, s."last_error" as last_error,
  coalesce(s."runs", 0) as runs,
  (s."last_run_at" is null or s."last_run_at" + j.every_interval <= now()) as due
from (values
    ('expire_approvals', '"better_supabase"."expire_approvals"', interval '15 minutes'),
    ('expire_support_sessions', '"better_supabase"."expire_support_sessions"', interval '5 minutes'),
    ('purge_usage_events', '"better_supabase"."purge_usage_events"', interval '1 day')
  ) j (job, fn, every_interval)
left join "better_supabase"."maintenance_state" s on s."job" = j.job;
revoke all on "better_supabase"."maintenance_jobs" from public, anon, authenticated;
grant select on "better_supabase"."maintenance_jobs" to service_role;

-- Runs every due job (or the one named, whether due or not, when job_name is set;
-- force_run runs due-or-not jobs) and records each outcome. One failing job never
-- stops the rest. Returns [{ job, status, result | error }]. Overlapping calls
-- skip: the second returns an empty list.
create or replace function "better_supabase"."maintenance"(job_name text default null, force_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job record;
  v_result jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('better_supabase.maintenance')) then
    return v_out;
  end if;
  for v_job in
    select j.job, j.function from "better_supabase"."maintenance_jobs" j
    where (maintenance.job_name is null and (maintenance.force_run or j.due)) or j.job = maintenance.job_name
    order by j.job
  loop
    begin
      execute pg_catalog.format('select pg_catalog.to_jsonb(%s())', v_job.function) into v_result;
      insert into "better_supabase"."maintenance_state" ("job", "last_run_at", "last_status", "last_result", "last_error", "runs")
      values (v_job.job, now(), 'ok', v_result, null, 1)
      on conflict ("job") do update set "last_run_at" = now(), "last_status" = 'ok',
        "last_result" = excluded."last_result", "last_error" = null, "runs" = "better_supabase"."maintenance_state"."runs" + 1;
      v_out := v_out || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('job', v_job.job, 'status', 'ok', 'result', v_result));
    exception when others then
      insert into "better_supabase"."maintenance_state" ("job", "last_run_at", "last_status", "last_result", "last_error", "runs")
      values (v_job.job, now(), 'error', null, sqlerrm, 1)
      on conflict ("job") do update set "last_run_at" = now(), "last_status" = 'error',
        "last_result" = null, "last_error" = excluded."last_error", "runs" = "better_supabase"."maintenance_state"."runs" + 1;
      v_out := v_out || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('job', v_job.job, 'status', 'error', 'error', sqlerrm));
    end;
  end loop;
  return v_out;
end;
$$;

-- Registers one pg_cron job that calls maintenance(), and returns 'pg_cron',
-- or returns 'none' when pg_cron isn't installed so the app can call
-- maintenance() from its own scheduler (a cron route, the queue worker).
create or replace function "better_supabase"."maintenance_schedule"(cron_schedule text default '*/5 * * * *')
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule regprocedure := pg_catalog.to_regprocedure('cron.schedule(text, text, text)');
begin
  if v_schedule is null then
    return 'none';
  end if;
  execute pg_catalog.format('select cron.schedule(%L, %L, %L)', 'better-supabase-maintenance', maintenance_schedule.cron_schedule, 'select "better_supabase"."maintenance"()');
  return 'pg_cron';
end;
$$;

-- Which scheduler runs maintenance(): 'pg_cron' when the job is registered,
-- else 'none'. A 'none' answer with due jobs means nothing is running them.
create or replace function "better_supabase"."maintenance_scheduler"()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs regclass := pg_catalog.to_regclass('cron.job');
  v_found boolean := false;
begin
  if v_jobs is not null then
    execute pg_catalog.format('select exists (select 1 from %s where jobname = ''better-supabase-maintenance'')', v_jobs) into v_found;
  end if;
  return case when v_found then 'pg_cron' else 'none' end;
end;
$$;

revoke execute on function better_supabase.maintenance(text, boolean) from public, anon, authenticated;
grant execute on function better_supabase.maintenance(text, boolean) to service_role;
revoke execute on function better_supabase.maintenance_schedule(text) from public, anon, authenticated;
grant execute on function better_supabase.maintenance_schedule(text) to service_role;
revoke execute on function better_supabase.maintenance_scheduler() from public, anon, authenticated;
grant execute on function better_supabase.maintenance_scheduler() to service_role;
