export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "jwt",
    capabilities: true,
  },
};
