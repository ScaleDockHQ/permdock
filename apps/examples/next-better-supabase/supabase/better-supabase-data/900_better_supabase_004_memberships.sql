-- better-supabase module: memberships
-- @bsb-block-data memberships
-- @bsb-hash sha256:0bf566194ea1eda38d7475a6cb148c1899e3ee0dfbae1e37c0de887381adeb28
-- Rows and settings a schema diff doesn't capture. Run `better-supabase add --adopt`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.blocks (name, version, mode)
values ('memberships', 2, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
