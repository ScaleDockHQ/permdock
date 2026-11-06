export default {
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "guc",
    scopeTypes: { tenant: "text" },
    actions: {
      assignRole: "none",
      invite: "none",
      manage: "none",
      revokeAll: "none",
    },
  },
};
