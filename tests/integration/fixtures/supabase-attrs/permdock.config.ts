import { fromTable } from "permdock/supabase";

export default {
  permissions: "../abac/permissions.ts",
  policy: "../abac/policy.ts",
  rls: { dialect: "supabase", authorize: "jwt", tenantType: "text" },
  supabase: {
    hook: {
      memberships: [fromTable({ table: "memberships" })],
      roles: false,
      version: false,
      attrs: {
        table: "profiles",
        columns: ["region", "clearance", "app_metadata.regions"],
      },
    },
  },
};
