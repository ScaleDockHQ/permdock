-- better-supabase sql data: the rows and settings of updated-at, audit, which a schema diff skips.

-- better-supabase SQL kit: updated-at (0.5.1)
-- @bs-kit-data updated-at
-- Rows and settings a schema diff doesn't capture. Run `better-supabase sql data`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase sql add`; re-running it overwrites this file.
-- Change it through `kits` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.kit_modules (name, version, mode)
values ('updated-at', 1, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();

-- better-supabase SQL kit: audit (0.5.1)
-- @bs-kit-data audit
-- Rows and settings a schema diff doesn't capture. Run `better-supabase sql data`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase sql add`; re-running it overwrites this file.
-- Change it through `kits` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.kit_modules (name, version, mode)
values ('audit', 2, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
