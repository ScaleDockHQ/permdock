DROP POLICY "quotes_support_read_only" ON "public"."quotes";

CREATE POLICY "quotes_update_read_only_actors" ON "public"."quotes"
  AS RESTRICTIVE
  FOR UPDATE
  TO "authenticated"
  USING
    (((NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = ANY (ARRAY['support'::text, 'impersonation'::text])) OR ((((( SELECT auth.jwt() AS jwt) ->
    'act'::text) ->> 'kind'::text) IS NULL) AND ((( SELECT auth.jwt() AS jwt) -> 'act'::text) ? 'session_id'::text))),
    false)) OR COALESCE((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) = 'false'::text), false)))
  WITH
    CHECK
    (((NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = ANY (ARRAY['support'::text, 'impersonation'::text])) OR ((((( SELECT auth.jwt() AS jwt) ->
    'act'::text) ->> 'kind'::text) IS NULL) AND ((( SELECT auth.jwt() AS jwt) -> 'act'::text) ? 'session_id'::text))),
    false)) OR COALESCE((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) = 'false'::text), false)));
