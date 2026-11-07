-- permdock:indexes v1
create index "permdock_contacts_user_id_idx" on "public"."contacts" ("user_id");
create index "permdock_quotes_customer_id_idx" on "public"."quotes" ("customer_id");
create index "permdock_quotes_organization_id_idx" on "public"."quotes" ("organization_id");
create index "permdock_staff_organization_id_idx" on "public"."staff" ("organization_id");
