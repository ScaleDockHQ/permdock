/** The ownership fixture with each membership row holding a `tier` key and an `org_roles` reference. */
const sources = [
  "tier",
  { through: "org_roles", on: { role_id: "id" }, column: "key" },
];

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
          role: sources,
          columns: { org: "org_id" },
        },
      },
      resource: {
        ledger: {
          table: "ledger_members",
          id: "ledger_id",
          user: "user_id",
          role: sources,
          via: "via",
        },
      },
    },
  },
};
