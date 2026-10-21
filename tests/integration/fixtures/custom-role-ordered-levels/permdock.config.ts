export default {
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    customRoles: true,
    memberships: {
      tenant: {
        table: "organization_members",
        tenant: "organization_id",
        user: "user_id",
        role: "role",
      },
    },
  },
};
