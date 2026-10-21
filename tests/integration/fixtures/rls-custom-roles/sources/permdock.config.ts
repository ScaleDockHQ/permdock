import { junctionMembershipSource } from "permdock/supabase";

export default {
  permissions: "../permissions.ts",
  policy: "../policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    customRoles: true,
    membershipSources: [
      junctionMembershipSource({
        table: "organization_members",
        scope: "tenant",
        id: "organization_id",
        roles: "role",
      }),
      junctionMembershipSource({
        table: "team_members",
        scope: "team",
        id: "team_id",
        within: { tenant: "organization_id" },
        roles: "role",
      }),
    ],
  },
};
