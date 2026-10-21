export default {
  permissions: "./src/permissions.ts",
  policy: "./src/policy.ts",
  rls: { dialect: "supabase", scopeTypes: { tenant: "text" } },
};
