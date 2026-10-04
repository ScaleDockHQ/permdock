/** CentraKit adopting PermDock: generated policies, its own verbs, shims under its legacy helpers, platform custom roles. */
export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    tenantType: "uuid",
    customRoles: true,
    shims: true,
    actions: { view: "select", archive: "none", pay: "none" },
    memberships: {
      tenant: {
        table: "organization_members",
        tenant: "organization_id",
        user: "user_id",
        role: "role",
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
