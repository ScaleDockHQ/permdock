import { defineConfig } from "permdock/cli";
import { rls } from "permdock/cli/plugins/rls";
import { supabaseHook } from "permdock/cli/plugins/supabase-hook";

export default defineConfig({
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  supabase: { hook: { schema: "permdock" } },
  rls: {
    memberships: {
      scopes: {
        tenant: {
          table: "members",
          columns: { tenant: "tenant_id" },
          user: "user_id",
          role: "role",
        },
      },
    },
  },
  plugins: [
    rls({
      dialect: "supabase",
      memberships: {
        scopes: {
          tenant: {
            table: "members",
            columns: { tenant: "tenant_id" },
            user: "user_id",
            role: "role",
          },
        },
      },
    }),
    supabaseHook(),
  ],
});
