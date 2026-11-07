import { rls } from "permdock/cli/plugins/rls";
import { supabaseHook } from "permdock/cli/plugins/supabase-hook";

export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    actions: { archive: "none", assign: "none", export: "none" },
    memberships: {
      scopes: {
        tenant: {
          table: "tenant_members",
          user: "user_id",
          role: "role",
          columns: { tenant: "org_id" },
        },
      },
    },
  },
  supabase: { hook: {} },
  plugins: [rls({ target: "sql", out: "out.sql" }), supabaseHook()],
};
