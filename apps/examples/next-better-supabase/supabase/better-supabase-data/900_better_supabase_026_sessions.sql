-- better-supabase module: sessions
-- @bsb-block-data sessions
-- @bsb-hash sha256:6afd74c5a23b192fe1cd9ad6d1b70ee22dcbde1306ce978089853db5fa05bc17
-- Rows and settings a schema diff doesn't capture. Run `better-supabase add --adopt`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.blocks (name, version, mode)
values ('sessions', 1, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
