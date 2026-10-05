/** Custom roles named by rows of the application's own roles table, which cascade to their grants. */
export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    customRoles: true,
    customRoleWrites: {
      roles: {
        table: "app_roles",
        key: "name",
        tenant: "organization_id",
        skip: "builtin",
      },
    },
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
