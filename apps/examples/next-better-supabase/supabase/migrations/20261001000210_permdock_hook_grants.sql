-- permdock:grants v1 schema=permdock
-- supabase_auth_admin: the grants and read policies the hook needs
grant usage on schema "permdock" to supabase_auth_admin;
grant execute on function "permdock".custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function "permdock".custom_access_token_hook(jsonb) from authenticated, anon, public;
grant usage on schema "public" to supabase_auth_admin;
grant execute on function "public"."datetime_preference_claims"(uuid) to supabase_auth_admin;
grant execute on function "public"."feature_claims"(uuid) to supabase_auth_admin;
grant execute on function "permdock".member_organization_ids_for(uuid) to supabase_auth_admin;
grant execute on function "permdock".member_customer_ids_for(uuid) to supabase_auth_admin;
grant usage on schema "public" to supabase_auth_admin;
grant select on table "public"."memberships" to supabase_auth_admin;
drop policy if exists "permdock_auth_admin_read_memberships" on "public"."memberships";
create policy "permdock_auth_admin_read_memberships" on "public"."memberships"
  as permissive for select
  to supabase_auth_admin
  using (true);
grant select on table "public"."contacts" to supabase_auth_admin;
drop policy if exists "permdock_auth_admin_read_memberships" on "public"."contacts";
create policy "permdock_auth_admin_read_memberships" on "public"."contacts"
  as permissive for select
  to supabase_auth_admin
  using (true);
grant select on table "permdock"."user_roles" to supabase_auth_admin;
drop policy if exists "permdock_auth_admin_read_roles" on "permdock"."user_roles";
create policy "permdock_auth_admin_read_roles" on "permdock"."user_roles"
  as permissive for select
  to supabase_auth_admin
  using (true);
grant select on table "permdock"."permdock_authz_version" to supabase_auth_admin;
drop policy if exists "permdock_auth_admin_read_version" on "permdock"."permdock_authz_version";
create policy "permdock_auth_admin_read_version" on "permdock"."permdock_authz_version"
  as permissive for select
  to supabase_auth_admin
  using (true);
