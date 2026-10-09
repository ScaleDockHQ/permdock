DROP TRIGGER "bs_audit" ON "public"."contacts";

DROP TRIGGER "bs_audit" ON "public"."customers";

DROP TRIGGER "bs_audit" ON "public"."datetime_preferences";

DROP TRIGGER "bs_audit" ON "public"."organizations";

DROP TRIGGER "bs_audit" ON "public"."quotes";

DROP TRIGGER "bs_audit" ON "public"."staff";

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore": ["updated_at"], "redact": [], "key_columns": ["id"]}');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore": ["updated_at"], "redact": [], "key_columns": ["id"]}');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.datetime_preferences
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore": ["updated_at"], "redact": [], "key_columns": ["user_id"]}');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore": ["updated_at"], "redact": [], "key_columns": ["id"]}');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore": ["updated_at"], "redact": [], "key_columns": ["id"]}');

CREATE TRIGGER bs_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.staff
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore": ["updated_at"], "redact": [], "key_columns": ["id"]}');
