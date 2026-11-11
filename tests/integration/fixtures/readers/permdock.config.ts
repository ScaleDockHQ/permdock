import { tableMembershipSource } from "permdock/supabase";

/**
 * The readers the hook and better-supabase call: a membership source with no
 * suspension of its own, so `memberships_for` applies `rls.suspension` itself,
 * and a teams table with a disabled column.
 */
const memberships = [
  tableMembershipSource({ table: "memberships", columns: { via: "via" } }),
];

const suspension = {
  users: { table: "profiles", id: "id", disabledAt: "disabled_at" },
  scopes: {
    organization: {
      table: "organization",
      id: "id",
      disabledAt: "disabled_at",
    },
  },
};

export default {
  permissions: "../named-scopes/policy.ts",
  policy: "../named-scopes/policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    actions: { accept: "none", disable: "none", pay: "none" },
    scopeTypes: { tenant: "text" },
    membershipSources: memberships,
    suspension,
  },
  supabase: {
    hook: {
      memberships,
      teams: {
        table: "team_members",
        user: "user_id",
        team: "team_id",
        tenant: "organization_id",
        disabledAt: "disabled_at",
      },
      budget: 600,
    },
  },
};
