import { junctionMembershipSource } from "permdock/supabase";

import base from "../row-memo/permdock.config.ts";

const { idTypes: _idTypes, ...rls } = base.rls;

export default {
  ...base,
  permissions: "../row-memo/policy.ts",
  policy: "../row-memo/policy.ts",
  rls,
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
