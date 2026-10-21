/**
 * Support and impersonation sessions are read-only in the database unless the
 * token says otherwise.
 */
export default {
  permissions: "../assignments/policy.ts",
  policy: "../assignments/policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    readOnlyActors: true,
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
