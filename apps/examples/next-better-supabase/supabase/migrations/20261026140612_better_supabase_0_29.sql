SET local check_function_bodies = off;

DROP POLICY "bsb_tenant_scope" ON "better_supabase"."share_links";

DROP POLICY "bsb_tenant_scope" ON "public"."organization_memberships";

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."share_links"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."share_links"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."share_links"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."share_links"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_delete" ON "public"."organization_memberships"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((organization_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "public"."organization_memberships"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((organization_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "public"."organization_memberships"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((organization_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR ((user_id = ( SELECT auth.uid() AS uid)) OR (organization_id IN (
    SELECT better_supabase.member_organization_ids() AS member_organization_ids)))));

CREATE POLICY "bsb_tenant_scope_update" ON "public"."organization_memberships"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((organization_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((organization_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

REVOKE ALL ON FUNCTION "better_supabase"."has_organization_role"(uuid, text[]) FROM "anon";

GRANT EXECUTE ON FUNCTION "better_supabase"."has_organization_role"(uuid, text[]) TO "anon";

REVOKE ALL ON FUNCTION "better_supabase"."member_organization_ids"(text[]) FROM "anon";

GRANT EXECUTE ON FUNCTION "better_supabase"."member_organization_ids"(text[]) TO "anon";
