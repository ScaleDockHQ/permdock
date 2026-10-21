export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "guc",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    memberships: {
      resource: {
        project: {
          table: "project_members",
          id: "project_id",
          user: "user_id",
          role: "role",
        },
      },
    },
  },
};
