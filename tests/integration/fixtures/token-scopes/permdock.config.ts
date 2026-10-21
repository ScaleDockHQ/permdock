/**
 * The oauth-scopes policy with the SQL helpers narrowing delegated tokens by
 * their scope claim.
 */
export default {
  permissions: "../oauth-scopes/permissions.ts",
  policy: "../oauth-scopes/policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    tokenScopes: true,
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
