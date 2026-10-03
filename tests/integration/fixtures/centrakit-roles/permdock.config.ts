import { sources, suspension } from "../centrakit/sources.ts";

/** CentraKit's real `user_roles (user_id, role_id references roles(id))`: role keys live on `roles.key`. */
export default {
  permissions: "../centrakit/policy.ts",
  policy: "../centrakit/policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    tenantType: "uuid",
    suspension,
    roles: {
      table: "user_roles",
      role: { through: "roles", on: { role_id: "id" }, column: "key" },
    },
  },
  supabase: { hook: { memberships: sources(), suspension } },
};
