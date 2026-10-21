/**
 * Role assignments checked in the database on the memberships table and the
 * global-roles table, refusing writes to the caller's own rows.
 */
export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    roles: { table: "user_roles", user: "user_id", role: "role" },
    assignments: { ownRole: "refuse" },
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
