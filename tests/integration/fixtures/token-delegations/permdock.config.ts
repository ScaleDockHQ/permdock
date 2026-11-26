/**
 * A policy that hands `task.read` to every OAuth client, with the SQL helpers
 * capping a client token at that delegation.
 */
export default {
  permissions: "../oauth-scopes/permissions.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    tokenScopes: { delegations: true },
    tables: { task: "task" },
    memberships: {
      scopes: {
        tenant: {
          table: "organization_members",
          columns: { tenant: "organization_id" },
          user: "user_id",
          role: "role",
        },
      },
    },
  },
};
