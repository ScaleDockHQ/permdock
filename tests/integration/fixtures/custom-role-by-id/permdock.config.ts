export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    customRoles: true,
    trustedReaders: ["role_reader"],
    customRoleWrites: {
      roles: {
        table: "roles",
        key: "key",
        tenant: "organization_id",
        skip: "is_system",
        primaryKey: "id",
      },
      audit: { function: "public.audit_event", args: { source: "permdock" } },
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
