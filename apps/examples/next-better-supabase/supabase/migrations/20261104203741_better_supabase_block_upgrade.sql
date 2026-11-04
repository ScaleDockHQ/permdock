-- better-supabase upgrade: steps that run before the schema diff.

-- audit: version 9 to 10. audit() takes statement => true, which audits with statement-level triggers over transition tables and writes one insert per statement; audit_statement_change() is the trigger function.
drop function if exists better_supabase.audit(regclass, text[], boolean, text[], text, text, text, text, text, text, regprocedure, boolean);
