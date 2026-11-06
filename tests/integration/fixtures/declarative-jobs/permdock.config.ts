import { defineConfig } from "permdock/cli";
import { rls } from "permdock/cli/plugins/rls";
import { supabaseHook } from "permdock/cli/plugins/supabase-hook";

/**
 * Lienlink's generate options. This file stays at or under 109 lines. authorize
 * database, seeds view, split, out, rowHelpers, follows, remove none, three
 * false tables, hook security definer, teams.
 */
export default defineConfig({
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  supabase: {
    hook: {
      security: "definer",
      teams: {
        table: "public.team_members",
        user: "user_id",
        team: "team_id",
        tenant: "organization_id",
      },
    },
  },
  plugins: [
    rls({
      dialect: "supabase",
      authorize: "database",
      seeds: "view",
      split: ["helpers", "hook"],
      out: "supabase/schemas/permdock/{part}.sql",
      rowHelpers: ["job"],
      actions: { remove: "none" },
      memberships: {
        scopes: {
          tenant: {
            table: "organization_members",
            columns: { tenant: "organization_id" },
            user: "user_id",
            role: "role",
          },
        },
      },
      tables: {
        job: {
          table: "public.jobs",
          follows: { "public.job_parties": "job_id" },
        },
        ledger: false,
        cache: false,
        sessions: false,
      },
    }),
    supabaseHook(),
  ],
});
