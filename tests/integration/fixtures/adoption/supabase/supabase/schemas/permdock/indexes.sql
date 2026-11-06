-- permdock:indexes v1
create index "permdock_members_user_id_tenant_id_cov_idx" on "public"."members" ("user_id", "tenant_id") include ("role");
