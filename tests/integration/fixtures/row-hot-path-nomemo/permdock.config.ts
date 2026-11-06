export default {
  permissions: "../row-hot-path/policy.ts",
  policy: "../row-hot-path/policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    memo: "none",
    actions: { edit: "none" },
    rowHelpers: ["item"],
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
