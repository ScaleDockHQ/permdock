-- better-supabase module: updated-at
-- @bsb-block updated-at@1 managed
-- @bsb-hash sha256:bcd28016d049f206a4ddfcace4943748f72faa36f8dc1a31ee4cf2a1eadf91ce
-- Keeps an updated_at column current on every update.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create or replace function better_supabase.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The default column is assigned directly; jsonb_populate_record copies the
  -- whole row, so it only serves other column names.
  if tg_nargs = 0 or tg_argv[0] = 'updated_at' then
    new.updated_at := now();
  else
    new := jsonb_populate_record(new, jsonb_build_object(tg_argv[0], now()));
  end if;
  return new;
end;
$$;

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
    target, 'bsb_updated_at', 'updated_at|moddatetime|touch', replace_trigger
  );
  execute format('drop trigger if exists bsb_updated_at on %s', target);
  execute format(
    'create trigger bsb_updated_at before update on %s for each row execute function better_supabase.set_updated_at(%L)',
    target,
    column_name
  );
end;
$$;

revoke execute on function better_supabase.track_updated_at(regclass, text, boolean) from public, anon, authenticated;
