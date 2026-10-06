/** Support and impersonation sessions are read-only in the database unless the token says otherwise. */
export default {
  permissions: "../assignments/policy.ts",
  policy: "../assignments/policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    readOnlyActors: true,
    memberships: {
      tenant: {
        table: "organization_members",
        tenant: "organization_id",
        user: "user_id",
        role: "role",
      },
    },
  },
};
