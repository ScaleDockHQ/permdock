export default {
  permissions: "../rls-matrix/permissions.ts",
  policy: "../rls-matrix/policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    tables: { project: "app.project", task: "app.task" },
    memberships: {
      scopes: {
        tenant: {
          table: "app.organization_members",
          columns: { tenant: "organization_id" },
          user: "user_id",
          role: "role",
        },
      },
    },
  },
};
