export default {
  permissions: "../permissions.ts",
  policy: "../policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "jwt",
    customRoles: true,
  },
};
