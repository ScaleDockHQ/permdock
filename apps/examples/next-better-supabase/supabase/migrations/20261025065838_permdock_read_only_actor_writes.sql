DROP POLICY "approval_delegations_delete" ON "permdock"."approval_delegations";

DROP POLICY "approval_delegations_insert" ON "permdock"."approval_delegations";

DROP POLICY "approval_delegations_update" ON "permdock"."approval_delegations";

CREATE POLICY "approval_delegations_delete" ON "permdock"."approval_delegations"
  FOR DELETE
  TO "authenticated"
  USING ((((delegator)::text = (( SELECT permdock.permdock_user_id() AS permdock_user_id))::text) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)));

CREATE POLICY "approval_delegations_insert" ON "permdock"."approval_delegations"
  FOR INSERT
  TO "authenticated"
  WITH
    CHECK
    ((((delegator)::text = (( SELECT permdock.permdock_user_id() AS permdock_user_id))::text) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write) AND
    ((tenant IS NULL) OR (tenant IN ( SELECT (m.id)::text AS id
   FROM permdock.member_organization_ids() m(id))))));

CREATE POLICY "approval_delegations_update" ON "permdock"."approval_delegations"
  FOR UPDATE
  TO "authenticated"
  USING ((((delegator)::text = (( SELECT permdock.permdock_user_id() AS permdock_user_id))::text) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)))
  WITH
    CHECK
    ((((delegator)::text = (( SELECT permdock.permdock_user_id() AS permdock_user_id))::text) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write) AND
    ((tenant IS NULL) OR (tenant IN ( SELECT (m.id)::text AS id
   FROM permdock.member_organization_ids() m(id))))));

CREATE POLICY "role_permissions_delete_read_only_actors" ON "public"."role_permissions"
  AS RESTRICTIVE
  FOR DELETE
  TO "authenticated"
  USING (( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write));

CREATE POLICY "role_permissions_insert_read_only_actors" ON "public"."role_permissions"
  AS RESTRICTIVE
  FOR INSERT
  TO "authenticated"
  WITH CHECK (( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write));

CREATE POLICY "role_permissions_update_read_only_actors" ON "public"."role_permissions"
  AS RESTRICTIVE
  FOR UPDATE
  TO "authenticated"
  USING (( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write))
  WITH CHECK (( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write));
