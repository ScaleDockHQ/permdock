-- better-supabase upgrade: steps pg-delta can't express (renames, backfills, expression changes).
-- Review them before you apply this migration; the module files hold everything else.
-- destructive: reviewed

-- audit: version 13 to 14. audit() takes archive_column and archive_value, so an update that sets or clears a soft-delete or status column is recorded as <entity>.archived or .restored; block tables with an archive column pass it.
do $$ begin drop function if exists better_supabase.audit(regclass, text[], boolean, text[], text, text, text, text, text, text, regprocedure, boolean, boolean); exception when dependent_objects_still_exist then null; end $$;

