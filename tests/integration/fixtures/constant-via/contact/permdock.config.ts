export default {
  permissions: "../policy.ts",
  policy: "../policy.ts",
  rls: {
    dialect: "guc",
    tenantType: "text",
    authorize: "database",
    memberships: {
      scopes: {
        org: {
          table: "contact_members",
          user: "user_id",
          role: "role",
          columns: { org: "org_id" },
          via: { value: "contact" },
        },
      },
    },
  },
};
