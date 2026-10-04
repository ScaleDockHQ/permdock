-- better-supabase SQL kit: updated-at (0.5.1)
-- @bs-kit updated-at@1 managed
-- Keeps an updated_at column current on every update.
-- Managed by `better-supabase sql add`; re-running it overwrites this file.
-- Change it through `kits` in better-supabase.config.ts and the module's SQL hooks.

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


create or replace function better_supabase.replace_equivalent_triggers(
  target regclass,
  kit_trigger text,
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
$$;
revoke execute on function better_supabase.replace_equivalent_triggers(regclass, text, text, boolean) from public, anon, authenticated;

drop function if exists better_supabase.track_updated_at(regclass, text);

-- select better_supabase.track_updated_at('public.customers');
-- replace_trigger => true drops another trigger that sets updated_at (moddatetime, touch_*).
create or replace function better_supabase.track_updated_at(
  target regclass,
  column_name text default 'updated_at',
  replace_trigger boolean default false
)
returns void
language plpgsql
set search_path = ''
as $$
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
$$;

revoke execute on function better_supabase.track_updated_at(regclass, text, boolean) from public, anon, authenticated;

create schema if not exists better_supabase;
create table if not exists better_supabase.kit_modules (
  name text primary key,
  version integer not null,
  mode text not null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table better_supabase.kit_modules enable row level security;
revoke all on better_supabase.kit_modules from anon, authenticated;
grant select on better_supabase.kit_modules to service_role;
