-- better-supabase module: approvals
-- @bsb-block-data approvals
-- @bsb-hash sha256:99b9b2dbc91ec8b0d2e7c4e2ec1ff86092b404317dd47de7132a871a8f490cb9
-- Rows and settings a schema diff doesn't capture. Run `better-supabase add --adopt`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.blocks (name, version, mode)
values ('approvals', 6, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
