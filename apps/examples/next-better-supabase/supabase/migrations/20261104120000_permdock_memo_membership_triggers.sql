CREATE TRIGGER permdock_memo_generation
  AFTER INSERT OR DELETE OR UPDATE ON permdock.user_roles
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation
  AFTER INSERT OR DELETE OR UPDATE ON public.contacts
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation
  AFTER INSERT OR DELETE OR UPDATE ON public.organization_memberships
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation_truncate
  AFTER TRUNCATE ON permdock.user_roles
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation_truncate
  AFTER TRUNCATE ON public.contacts
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();

CREATE TRIGGER permdock_memo_generation_truncate
  AFTER TRUNCATE ON public.organization_memberships
  FOR EACH STATEMENT
  EXECUTE FUNCTION permdock.permdock_memo_generation();
