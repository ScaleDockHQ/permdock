-- better-supabase module: unscoped
-- @bsb-block unscoped@1 managed
-- @bsb-hash sha256:08de6762b572cd3302fb0762cee4772dffd1764bb0ec4708999253ec1fd8cd47
-- Event triggers and triggers on auth tables. They belong to no schema of the app, so a diff limited to some schemas never plans them; keeping them here puts them in one place to read.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

create event trigger bsb_audit_forget_dropped on sql_drop
  when tag in ('DROP TABLE', 'DROP SCHEMA')
  execute function better_supabase.audit_forget_dropped();

create trigger "bsb_sso_auth_user" after insert or update of email, email_confirmed_at on auth.users
  for each row execute function "better_supabase"."sso_on_auth_user"();
