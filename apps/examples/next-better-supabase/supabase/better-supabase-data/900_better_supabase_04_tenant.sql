-- better-supabase module: tenant (0.12.0)
-- @bs-module-data tenant
-- Rows and settings a schema diff doesn't capture. Run `better-supabase sql data`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase add`; re-running it overwrites this file.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.modules (name, version, mode)
values ('tenant', 2, 'adopt')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
