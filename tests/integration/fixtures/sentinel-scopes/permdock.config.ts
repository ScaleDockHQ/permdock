export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "guc",
    scopeTypes: { zorg: "text", zcust: "text" },
    authorize: "database",
    memberships: {
      scopes: {
        zorg: {
          table: "zorg_people",
          user: "user_id",
          role: "role",
          columns: { zorg: "zorg_id" },
        },
        zcust: {
          table: "zcust_people",
          user: "user_id",
          role: "role",
          columns: { zcust: "zcust_id", zorg: "zorg_id" },
        },
      },
    },
  },
};
