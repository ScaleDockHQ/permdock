import { junctionMembershipSource } from "permdock/supabase";

export default {
  permissions: "../rls-matrix/permissions.ts",
  policy: "../rls-matrix/policy.ts",
  rls: { dialect: "supabase", tenantType: "text", authorize: "jwt" },
  supabase: {
    hook: {
      roles: false,
      budget: 400,
      teams: {
        table: "team_members",
        user: "user_id",
        team: "team_id",
        tenant: "organization_id",
      },
      memberships: [
        junctionMembershipSource({
          table: "organization_members",
          scope: "tenant",
          id: "organization_id",
          roles: "role",
        }),
      ],
    },
  },
};
