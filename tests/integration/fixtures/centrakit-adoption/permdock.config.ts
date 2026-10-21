/**
 * CentraKit adopting PermDock: generated policies, its own verbs, shims under
 * its legacy helpers, platform and organization custom roles, and
 * `organization_users.role_id` read through `roles.key`.
 */
export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    scopeTypes: { tenant: "uuid" },
    customRoles: true,
    shims: true,
    actions: { view: "select", archive: "none", pay: "none" },
    memberships: {
      scopes: {
        tenant: {
          table: "organization_users",
          columns: { tenant: "organization_id" },
          user: "user_id",
          role: { through: "roles", on: { role_id: "id" }, column: "key" },
        },
      },
    },
    migrate: {
      helpers: {
        org_ids_with_permission: { form: "ids", scope: "organization" },
        has_org_permission: { form: "row", scope: "organization" },
        is_system_user_with: { form: "global" },
      },
      prefixes: { "organization.": "" },
      globalScopes: ["system"],
    },
  },
};
