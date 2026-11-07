export default {
  permissions: "../policy.ts",
  policy: "../policy.ts",
  rls: {
    dialect: "guc",
    scopeTypes: { tenant: "text" },
    authorize: "jwt",
    actions: { accept: "none", disable: "none", pay: "none" },
  },
};
