export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "guc",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    tables: {
      deploy: {
        table: "deployments",
        via: { table: "cloud.environments", column: "org_id", type: "text" },
      },
    },
    memberships: {
      scopes: {
        org: {
          table: "members",
          user: "user_id",
          role: "role",
          columns: { org: "org_id" },
        },
      },
    },
  },
};
