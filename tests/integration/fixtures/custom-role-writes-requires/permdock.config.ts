export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    customRoles: true,
    customRoleWrites: { requires: "manageRoles" },
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
