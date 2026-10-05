import { roleKey, sources, suspension } from "./sources.ts";

/**
 * CentraKit's real role tables: `user_roles (user_id, role_id)` and
 * `organization_users (user_id, organization_id, role_id)` both reference
 * `roles (id, scope, key, organization_id)`, and role keys live on `roles.key`.
 */
export default {
  permissions: "../centrakit/policy.ts",
  policy: "../centrakit/policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    tenantType: "uuid",
    suspension,
    roles: { table: "user_roles", role: roleKey },
  },
  supabase: { hook: { memberships: sources(), suspension } },
};
