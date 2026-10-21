/**
 * Role assignments checked in the database, on the memberships table and an
 * invitations table.
 */
export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    customRoles: true,
    assignments: {
      tables: [
        {
          table: "invitations",
          scope: "tenant",
          id: "organization_id",
          role: "role",
        },
      ],
    },
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
