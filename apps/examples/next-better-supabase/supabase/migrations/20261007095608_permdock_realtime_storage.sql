CREATE POLICY "permdock_realtime_org_organization_quotes_insert" ON "realtime"."messages"
  FOR INSERT
  TO "authenticated"
  WITH
    CHECK
    (((extension = ANY (ARRAY['broadcast'::text, 'presence'::text])) AND (( SELECT realtime.topic() AS topic) ~ '^org:[^:]+:quotes$'::text) AND (split_part(( SELECT
    realtime.topic() AS topic), ':'::text, 2) IN ( SELECT (x.x)::text AS x
   FROM permdock.permitted_organization_ids('quotes.update'::text) x(x)))));

CREATE POLICY "permdock_realtime_org_organization_quotes_select" ON "realtime"."messages"
  FOR SELECT
  TO "authenticated"
  USING
    (((EXTENSION = ANY (ARRAY['broadcast'::text, 'presence'::text])) AND (( SELECT realtime.topic() AS topic) ~ '^org:[^:]+:quotes$'::text) AND (split_part(( SELECT
    realtime.topic() AS topic), ':'::text, 2) IN ( SELECT (x.x)::text AS x
   FROM permdock.permitted_organization_ids('quotes.read'::text) x(x)))));

CREATE POLICY "realtime_messages_insert_read_only_actors" ON "realtime"."messages"
  AS RESTRICTIVE
  FOR INSERT
  TO "authenticated"
  WITH
    CHECK
    (((NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = ANY (ARRAY['support'::text, 'impersonation'::text])) OR ((((( SELECT auth.jwt() AS jwt) ->
    'act'::text) ->> 'kind'::text) IS NULL) AND ((( SELECT auth.jwt() AS jwt) -> 'act'::text) ? 'session_id'::text))),
    false)) OR COALESCE((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) = 'false'::text), false)));

CREATE POLICY "permdock_storage_quote_files_delete" ON "storage"."objects"
  FOR DELETE
  TO "authenticated"
  USING (((bucket_id = 'quote-files'::text) AND ((storage.foldername(name))[1] IN ( SELECT (x.x)::text AS x
   FROM permdock.permitted_organization_ids('quotes.update'::text) x(x)))));

CREATE POLICY "permdock_storage_quote_files_insert" ON "storage"."objects"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (((bucket_id = 'quote-files'::text) AND ((storage.foldername(name))[1] IN ( SELECT (x.x)::text AS x
   FROM permdock.permitted_organization_ids('quotes.update'::text) x(x)))));

CREATE POLICY "permdock_storage_quote_files_select" ON "storage"."objects"
  FOR SELECT
  TO "authenticated"
  USING (((bucket_id = 'quote-files'::text) AND ((storage.foldername(name))[1] IN ( SELECT (x.x)::text AS x
   FROM permdock.permitted_organization_ids('quotes.read'::text) x(x)))));

CREATE POLICY "permdock_storage_quote_files_update" ON "storage"."objects"
  FOR UPDATE
  TO "authenticated"
  USING (((bucket_id = 'quote-files'::text) AND ((storage.foldername(name))[1] IN ( SELECT (x.x)::text AS x
   FROM permdock.permitted_organization_ids('quotes.update'::text) x(x)))))
  WITH CHECK (((bucket_id = 'quote-files'::text) AND ((storage.foldername(name))[1] IN ( SELECT (x.x)::text AS x
   FROM permdock.permitted_organization_ids('quotes.update'::text) x(x)))));

CREATE POLICY "storage_objects_delete_read_only_actors" ON "storage"."objects"
  AS RESTRICTIVE
  FOR DELETE
  TO "authenticated"
  USING
    (((NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = ANY (ARRAY['support'::text, 'impersonation'::text])) OR ((((( SELECT auth.jwt() AS jwt) ->
    'act'::text) ->> 'kind'::text) IS NULL) AND ((( SELECT auth.jwt() AS jwt) -> 'act'::text) ? 'session_id'::text))),
    false)) OR COALESCE((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) = 'false'::text), false)));

CREATE POLICY "storage_objects_insert_read_only_actors" ON "storage"."objects"
  AS RESTRICTIVE
  FOR INSERT
  TO "authenticated"
  WITH
    CHECK
    (((NOT COALESCE(((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'kind'::text) = ANY (ARRAY['support'::text, 'impersonation'::text])) OR ((((( SELECT auth.jwt() AS jwt) ->
    'act'::text) ->> 'kind'::text) IS NULL) AND ((( SELECT auth.jwt() AS jwt) -> 'act'::text) ? 'session_id'::text))),
    false)) OR COALESCE((((( SELECT auth.jwt() AS jwt) -> 'act'::text) ->> 'read_only'::text) = 'false'::text), false)));

CREATE POLICY "storage_objects_update_read_only_actors" ON "storage"."objects"
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
