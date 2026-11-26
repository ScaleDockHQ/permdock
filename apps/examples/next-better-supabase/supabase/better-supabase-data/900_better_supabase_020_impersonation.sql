-- better-supabase module: impersonation
-- @bsb-block-data impersonation
-- @bsb-hash sha256:ea4c369286ceb0802093ae9b99a1268bd521184e493b6816545641d5102f4467
-- Rows and settings a schema diff doesn't capture. Run `better-supabase add --adopt`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.blocks (name, version, mode)
values ('impersonation', 3, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
