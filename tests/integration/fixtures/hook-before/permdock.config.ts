import { junctionMembershipSource } from "permdock/supabase";

export default {
  permissions: "../rls-matrix/permissions.ts",
  policy: "../rls-matrix/policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "jwt",
  },
  supabase: {
    hook: {
      before: ["auth_checks.require_verified", "auth_checks.tag_event"],
      roles: false,
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
