import { junctionMembershipSource } from "permdock/supabase";

export default {
  permissions: "../assignments/policy.ts",
  policy: "../assignments/policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "jwt",
  },
  supabase: {
    hook: {
      roles: false,
      memberships: [
        junctionMembershipSource({
          table: "contact_roles",
          scope: "tenant",
          id: "organization_id",
          user: {
            through: "contact_profiles",
            on: { contact_profile_id: "id" },
            column: "user_id",
          },
          roles: "role",
        }),
      ],
    },
  },
};
