-- better-supabase SQL kit: updated-at (0.4.0)
-- Keeps an updated_at column current on every update.
-- Managed by `better-supabase sql add`; re-running it overwrites this file.

create schema if not exists better_supabase;
grant usage on schema better_supabase to anon, authenticated, service_role;

create or replace function better_supabase.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new := jsonb_populate_record(
    new,
    jsonb_build_object(coalesce(tg_argv[0], 'updated_at'), now())
  );
  return new;
end;
$$;

-- select better_supabase.track_updated_at('public.customers');
create or replace function better_supabase.track_updated_at(
  target regclass,
  column_name text default 'updated_at'
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists bs_updated_at on %s', target);
  execute format(
    'create trigger bs_updated_at before update on %s for each row execute function better_supabase.set_updated_at(%L)',
    target,
    column_name
  );
end;
$$;
