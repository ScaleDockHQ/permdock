export default {
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    customRoles: true,
    memberships: {
      scopes: {
        tenant: {
          table: "organization_members",
          columns: { tenant: "organization_id" },
          user: "user_id",
          role: "role",
        },
        team: {
          table: "team_members",
          columns: { tenant: "organization_id", team: "team_id" },
          user: "user_id",
          role: "role",
        },
      },
    },
  },
};
