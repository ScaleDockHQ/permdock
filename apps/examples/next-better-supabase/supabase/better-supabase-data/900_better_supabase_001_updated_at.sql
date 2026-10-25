-- better-supabase module: updated-at
-- @bsb-block-data updated-at
-- @bsb-hash sha256:84094775e5aab9b1aea2ef256dc00640287eef63d140730c3c6c0e5390fcee95
-- Rows and settings a schema diff doesn't capture. Run `better-supabase add --adopt`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.blocks (name, version, mode)
values ('updated-at', 1, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
