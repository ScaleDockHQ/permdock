import { fromJunction } from "permdock/supabase";

import assignments from "../assignments/permdock.config.ts";

export default {
  ...assignments,
  permissions: "../assignments/policy.ts",
  policy: "../assignments/policy.ts",
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
