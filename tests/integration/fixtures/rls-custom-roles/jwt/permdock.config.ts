export default {
  permissions: "../permissions.ts",
  policy: "../policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "jwt",
    customRoles: true,
  },
};
