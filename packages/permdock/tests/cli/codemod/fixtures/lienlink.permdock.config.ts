export default {
  rls: {
    authorize: "database",
    out: "supabase/schemas/permdock/{part}.sql",
    split: ["helpers", "hook"],
    seeds: "view",
    rowHelpers: ["jobs"],
    actions: {
      remove: "none",
      read: "select",
      markPaid: "update",
      view: "select",
    },
    roles: { table: "public.platform_roles" },
    memberships: {
      scopes: {
        organization: {
          table: "public.organization_users",
          user: "user_id",
          role: "role",
          roles: "many",
        },
      },
    },
    customRoles: {
      from: {
        sync: "trigger",
        permissions: {
          table: "public.role_permissions",
          role: {
            through: "public.roles",
            on: { role_id: "id" },
            column: "key",
          },
          permission: "permission",
        },
      },
    },
    customRoleWrites: {
      roles: { table: "public.roles", key: "key", skip: "is_system" },
    },
    tables: { auditLog: false, webhook: false, event: false },
    migrate: { helpers: {}, prefixes: { "admin.": "" } },
  },
  powersync: { resources: ["jobs"] },
  supabase: {
    hook: {
      security: "definer",
      teams: { table: "public.team_members", user: "user_id", team: "team_id" },
    },
  },
};
