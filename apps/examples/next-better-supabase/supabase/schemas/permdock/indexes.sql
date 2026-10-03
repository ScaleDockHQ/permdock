-- permdock:indexes v1
create index if not exists "permdock_contacts_user_id_idx" on "public"."contacts" ("user_id");
create index if not exists "permdock_memberships_user_id_idx" on "public"."memberships" ("user_id");
create index if not exists "permdock_quotes_customer_id_idx" on "public"."quotes" ("customer_id");
create index if not exists "permdock_quotes_organization_id_idx" on "public"."quotes" ("organization_id");
create index if not exists "permdock_staff_organization_id_idx" on "public"."staff" ("organization_id");
