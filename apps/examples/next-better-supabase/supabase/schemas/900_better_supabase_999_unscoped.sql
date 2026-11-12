-- better-supabase module: unscoped
-- @bsb-block unscoped@1 managed
-- @bsb-hash sha256:ed35ec00b75be59805c7cde69feab41a8b205c6f61c9cf959877d8ca0975ae1a
-- Event triggers and triggers on auth tables. They belong to no schema of the app, so a diff limited to some schemas never plans them; keeping them here puts them in one place to read.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create event trigger bsb_audit_forget_dropped on sql_drop
  when tag in ('DROP TABLE', 'DROP SCHEMA')
  execute function better_supabase.audit_forget_dropped();
