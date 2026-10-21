import {
  junctionMembershipSource,
  tableMembershipSource,
} from "permdock/supabase";

/**
 * The ownership fixture with its organization memberships in two sources: a
 * table of every scope and a junction with a fixed role.
 */
export default {
  permissions: "../ownership/policy.ts",
  policy: "../ownership/policy.ts",
  rls: {
    dialect: "guc",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    membershipSources: [
      tableMembershipSource({
        table: "memberships",
        columns: { expiresAt: "expires_at" },
      }),
      junctionMembershipSource({
        table: "org_approvers",
        scope: "org",
        id: "org_id",
        roles: ["approver"],
      }),
    ],
    memberships: {
      resource: {
        ledger: {
          table: "ledger_members",
          id: "ledger_id",
          user: "user_id",
          role: "role",
          via: "via",
        },
      },
    },
  },
};
