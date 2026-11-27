-- better-supabase module: approvals
-- @bsb-block-data approvals
-- @bsb-hash sha256:da02e6ffffcd02aa45a310f334a3e7760cd0703fe3fb56be217118f66f4c56e8
-- Rows and settings a schema diff doesn't capture. Run `better-supabase add --adopt`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.blocks (name, version, mode)
values ('approvals', 8, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
