export default {
  permissions: "../rls-matrix/permissions.ts",
  policy: "../rls-matrix/policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    tables: { project: "app.project", task: "app.task" },
    memberships: {
      tenant: {
        table: "app.organization_members",
        tenant: "organization_id",
        user: "user_id",
        role: "role",
      },
    },
  },
};
