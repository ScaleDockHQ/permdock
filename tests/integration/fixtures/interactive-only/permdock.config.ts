export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    memo: "permdock",
    helpersOnly: true,
    rowHelpers: ["doc"],
    actions: { purge: "delete", transferOwnership: "update" },
    idTypes: { doc: "text" },
    apiKeys: true,
    tokenScopes: true,
    memberships: {
      scopes: {
        tenant: {
          table: "organization_members",
          columns: { tenant: "organization_id" },
          user: "user_id",
          role: "role",
        },
      },
    },
  },
};
