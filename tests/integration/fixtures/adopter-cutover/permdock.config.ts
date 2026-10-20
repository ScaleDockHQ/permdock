import { junctionMembershipSource } from "permdock/supabase";

export default {
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    rowHelpers: true,
    customRoles: {
      from: {
        sync: "trigger",
        permissions: {
          table: "app_role_permissions",
          role: { through: "app_roles", on: { role_id: "id" }, column: "name" },
          permission: "permission",
          effect: "effect",
          level: "level",
        },
      },
    },
    customRoleWrites: {
      roles: {
        table: "app_roles",
        key: "name",
        tenant: "organization_id",
        shared: "shared",
        skip: "is_system",
      },
    },
    membershipSources: [
      junctionMembershipSource({
        table: "organization_members",
        scope: "tenant",
        id: "organization_id",
        roles: { through: "app_roles", on: { role_id: "id" }, column: "name" },
      }),
    ],
  },
};
