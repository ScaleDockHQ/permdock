import { blockMembershipSource } from "permdock/better-supabase";
import { defineConfig } from "permdock/cli";
import { powersync } from "permdock/cli/plugins/powersync";
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
  powersync: { resources: ["jobs"], out: "sync-config.yaml" },
  rls: {
    dialect: "supabase",
    authorize: "database",
    rowHelpers: ["jobs"],
    actions: { remove: "none", manage: "none" },
    scopeTypes: { tenant: "uuid" },
    roles: { table: "public.platform_user_roles" },
    customRoles: {
      from: {
        sync: "trigger",
        permissions: {
          table: "role_permissions",
          role: { through: "roles", on: { role_id: "id" }, column: "name" },
          permission: "permission",
          level: "level",
        },
      },
    },
    customRoleWrites: {
      roles: { table: "roles", key: "name", tenant: "organization_id" },
    },
    tables: {
      jobs: {
        table: "public.jobs",
        also: ["jobParty"],
        follows: { "public.job_parties": "job_id" },
      },
      platformRole: false,
      ledger: false,
      cache: false,
      sessions: false,
    },
  },
  supabase: {
    hook: {
      security: "definer",
      memberships: [blockMembershipSource({ scope: "tenant", roles: "many" })],
      teams: {
        table: "better_supabase.team_members",
        user: "user_id",
        team: "team_id",
        tenant: "organization_id",
      },
    },
  },
  plugins: [
    rls({
      seeds: "view",
      split: ["helpers", "hook"],
      out: "supabase/schemas/permdock/{part}.sql",
    }),
    supabaseHook(),
    powersync(),
  ],
});
