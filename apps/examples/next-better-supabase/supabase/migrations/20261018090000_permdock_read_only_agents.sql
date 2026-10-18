SET local check_function_bodies = off;

DROP POLICY "quotes_update_read_only_actors" ON "public"."quotes";

CREATE OR REPLACE FUNCTION permdock.permdock_actor_may_write()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select (not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = any(array['support', 'impersonation']::text[]) or ((((select auth.jwt()) -> 'act') ->> 'kind') is null and ((select auth.jwt()) -> 'act') ? 'session_id'), false) or coalesce((((select auth.jwt()) -> 'act') ->> 'read_only') = 'false', false)) and not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = 'agent' and (((select auth.jwt()) -> 'act') ->> 'read_only') = 'true', false)
$function$;

CREATE POLICY "quotes_update_read_only_actors" ON "public"."quotes"
  AS RESTRICTIVE
  FOR UPDATE
  TO "authenticated"
  USING
    ((((NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = ANY (ARRAY['support'::text, 'impersonation'::text])) OR ((((( SELECT auth.jwt() AS jwt) ->
    'act'::text) ->> 'kind'::text) IS NULL) AND ((( SELECT auth.jwt() AS jwt) -> 'act'::text) ? 'session_id'::text))),
    false)) OR COALESCE((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) = 'false'::text), false)) AND
    (NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = 'agent'::text) AND (((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) =
    'true'::text)), false))))
  WITH
    CHECK
    ((((NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = ANY (ARRAY['support'::text, 'impersonation'::text])) OR ((((( SELECT auth.jwt() AS jwt) ->
    'act'::text) ->> 'kind'::text) IS NULL) AND ((( SELECT auth.jwt() AS jwt) -> 'act'::text) ? 'session_id'::text))),
    false)) OR COALESCE((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) = 'false'::text), false)) AND
    (NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = 'agent'::text) AND (((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) =
    'true'::text)), false))));

