-- better-supabase module: security-events
-- @bsb-block-data security-events
-- @bsb-hash sha256:568fda81d4fdbefffe9626c784a9d5794ce77fd93c3de9c933d0e67de0cfb115
-- Rows and settings a schema diff doesn't capture. Run `better-supabase add --adopt`
-- after the schema migration to put them in a migration.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

insert into better_supabase.blocks (name, version, mode)
values ('security-events', 1, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
