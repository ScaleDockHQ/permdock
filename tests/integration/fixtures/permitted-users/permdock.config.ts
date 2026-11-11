/**
 * `permitted_tenant_users` over every input it reads: declared and custom roles
 * at the tenant and globally, denies at both, an included role, expiry, a
 * disabled membership and a suspended user.
 */
export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    scopeTypes: { tenant: "uuid" },
    customRoles: true,
    memberships: {
      scopes: {
        tenant: {
          table: "organization_users",
          columns: { tenant: "organization_id" },
          user: "user_id",
          role: "role",
          expiresAt: "expires_at",
          disabledAt: "disabled_at",
        },
      },
    },
    suspension: {
      users: { table: "profiles", id: "user_id", disabledAt: "disabled_at" },
    },
  },
};
