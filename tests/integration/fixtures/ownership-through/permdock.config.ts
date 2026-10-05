/** The ownership fixture with `org_members.role_id` referencing `org_roles (id, key)`. */
export default {
  permissions: "../ownership/policy.ts",
  policy: "../ownership/policy.ts",
  rls: {
    dialect: "guc",
    tenantType: "text",
    authorize: "database",
    memberships: {
      scopes: {
        org: {
          table: "org_members",
          user: "user_id",
          role: { through: "org_roles", on: { role_id: "id" }, column: "key" },
          columns: { org: "org_id" },
        },
      },
      resource: {
        ledger: {
          table: "ledger_members",
          id: "ledger_id",
          user: "user_id",
          role: { through: "org_roles", on: { role_id: "id" }, column: "key" },
          via: "via",
        },
      },
    },
  },
};
