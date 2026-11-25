import { junctionMembershipSource } from "permdock/supabase";

import { memberships, suspension } from "../keep/permdock.config.ts";

/**
 * Organization B is suspended without `keep`, and the sources carry no
 * suspension themselves: the hook drops the entry and lists B in
 * `suspended_in`.
 */
const tenantSuspension = {
  users: suspension.users,
  scopes: {
    organization: {
      table: "organization",
      id: "id",
      disabledAt: "disabled_at",
    },
  },
};

export default {
  permissions: "../policy.ts",
  policy: "../policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "jwt",
    actions: { accept: "none", disable: "none", pay: "none" },
    suspension: tenantSuspension,
    memberships,
  },
  supabase: {
    hook: {
      memberships: [
        junctionMembershipSource({
          table: "organization_users",
          scope: "organization",
          id: "organization_id",
          roles: "role",
          via: "staff",
        }),
        junctionMembershipSource({
          table: "customer_contacts",
          scope: "customer",
          id: "customer_id",
          within: { organization: "organization_id" },
          roles: "role",
          via: "contact",
          expiresAt: "expires_at",
        }),
      ],
    },
  },
};
