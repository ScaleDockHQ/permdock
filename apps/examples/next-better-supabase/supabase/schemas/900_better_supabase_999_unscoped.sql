-- better-supabase module: unscoped
-- @bsb-block unscoped@1 managed
-- @bsb-hash sha256:dfab25e5da52aa12f040e604898ae7b579c2327160a73fa9fcfd7f82881d6080
-- Event triggers and triggers on auth tables. They belong to no schema of the app, so a diff limited to some schemas never plans them; keeping them here puts them in one place to read.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

drop event trigger if exists bsb_audit_forget_dropped;
create event trigger bsb_audit_forget_dropped on sql_drop
  when tag in ('DROP TABLE', 'DROP SCHEMA')
  execute function better_supabase.audit_forget_dropped();
