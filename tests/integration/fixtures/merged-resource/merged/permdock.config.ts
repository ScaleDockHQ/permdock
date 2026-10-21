export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    tables: { file: "file_nodes" },
    rowHelpers: ["file"],
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
