DROP POLICY "quotes_update_read_only_actors" ON "public"."quotes";

CREATE POLICY "quotes_update_read_only_actors" ON "public"."quotes"
  AS RESTRICTIVE
  FOR UPDATE
  TO "authenticated"
  USING (( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write))
  WITH CHECK (( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write));
