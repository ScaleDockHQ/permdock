import { fromJunction } from "permdock/supabase";

export default {
  permissions: "../permissions.ts",
  policy: "../policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    customRoles: true,
    membershipSources: [
      fromJunction({
        table: "organization_members",
        scope: "tenant",
        id: "organization_id",
        roles: "role",
      }),
      fromJunction({
        table: "team_members",
        scope: "team",
        id: "team_id",
        within: { tenant: "organization_id" },
        roles: "role",
      }),
    ],
  },
};
