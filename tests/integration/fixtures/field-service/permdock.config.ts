/**
 * `organization_users` holds a plan `tier` and an organization `role_id`,
 * both role sources. `user_roles` holds platform roles: `roles` rows with no
 * organization and `audience = 'system'`.
 */
const roleThrough = {
  through: "roles",
  on: { role_id: "id" },
  column: "key",
};

export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "guc",
    tenantType: "text",
    authorize: "database",
    customRoles: true,
    fixtures: "rls.fixtures.json",
    tables: { job: "jobs", customer: "customers" },
    roles: { table: "user_roles", role: roleThrough },
    memberships: {
      scopes: {
        organization: {
          table: "organization_users",
          user: "user_id",
          role: ["tier", roleThrough],
          columns: { organization: "organization_id" },
        },
      },
    },
  },
  powersync: { out: "sync-config.yaml" },
};
