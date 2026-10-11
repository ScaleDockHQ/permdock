/** Global roles referenced through the application's roles table, which also holds tenant custom roles under the same names. */
export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    customRoles: true,
    customRoleWrites: {
      roles: { table: "app_roles", key: "name", tenant: "organization_id" },
    },
    roles: {
      table: "user_roles",
      user: "user_id",
      role: { through: "app_roles", on: { role_id: "id" }, column: "name" },
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
