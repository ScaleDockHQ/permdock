import { junctionMembershipSource } from "permdock/supabase";

import assignments from "../assignments/permdock.config.ts";

export default {
  ...assignments,
  permissions: "../assignments/policy.ts",
  policy: "../assignments/policy.ts",
  rls: { ...assignments.rls, memo: "permdock" },
  supabase: {
    hook: {
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
