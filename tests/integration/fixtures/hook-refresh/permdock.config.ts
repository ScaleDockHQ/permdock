import {
  junctionMembershipSource,
  tableMembershipSource,
} from "permdock/supabase";

const suspension = {
  users: { table: "profiles", id: "id", disabledAt: "disabled_at" },
};

/**
 * Sources without `expiresAt` or a scope suspension: every change to them bumps
 * `authz_ver`, so the hook may reuse a refreshed token's memberships.
 */
function sources() {
  return [
    tableMembershipSource({
      table: "memberships",
      columns: { via: "via", managedBy: "managed_by", seats: "seats" },
      suspension,
    }),
    junctionMembershipSource({
      table: "customer_contacts",
      scope: "customer",
      within: { organization: "organization_id" },
      roles: ["contact"],
      via: "contact",
      suspension,
    }),
  ];
}

export default {
  permissions: "../named-scopes/policy.ts",
  policy: "../named-scopes/policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    actions: { accept: "none", disable: "none", pay: "none" },
    scopeTypes: { tenant: "text" },
    customRoles: true,
    membershipSources: sources(),
    suspension,
  },
  supabase: { hook: { memberships: sources(), suspension, oauth: "slim" } },
};
