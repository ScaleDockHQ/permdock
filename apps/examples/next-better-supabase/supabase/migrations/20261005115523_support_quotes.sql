CREATE POLICY "quotes_support_read_only" ON "public"."quotes"
  AS RESTRICTIVE
  FOR UPDATE
  TO "authenticated"
  USING
    (((NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = 'support'::text) OR ((( SELECT auth.jwt() AS jwt) -> 'act'::text) ? 'session_id'::text)), false)) OR (((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) = 'false'::text)));

CREATE POLICY "quotes_update" ON "public"."quotes"
  FOR UPDATE
  TO "authenticated"
  USING ((organization_id IN ( SELECT permdock.permitted_organization_ids('quotes.update'::text) AS permitted_organization_ids)))
  WITH CHECK ((organization_id IN ( SELECT permdock.permitted_organization_ids('quotes.update'::text) AS permitted_organization_ids)));

REVOKE ALL ON TABLE "public"."quotes" FROM "authenticated";

GRANT SELECT, UPDATE ON TABLE "public"."quotes" TO "authenticated";
