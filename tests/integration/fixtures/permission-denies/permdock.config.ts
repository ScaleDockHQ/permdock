import { fromJunction } from "permdock/supabase";

export default {
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    memberships: {
      tenant: {
        table: "organization_members",
        tenant: "organization_id",
        user: "user_id",
        role: "role",
      },
    },
  },
  supabase: {
    hook: {
      memberships: [
        fromJunction({
          table: "organization_members",
          scope: "tenant",
          id: "organization_id",
          roles: "role",
        }),
      ],
    },
  },
};
