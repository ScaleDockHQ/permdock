import { defineConfig } from "permdock/cli";
import { rls } from "permdock/cli/plugins/rls";
import { tableMembershipSource } from "permdock/supabase";

import { permissions, policy, seeds } from "./policy.ts";

/**
 * The one place memberships, suspension, platform roles, approvers and seed
 * personas are written down. `better-supabase.config.ts` reads them through the
 * manifest `permdock supabase inspect --out` writes.
 */
const memberships = [tableMembershipSource({ table: "memberships" })];

export default defineConfig({
  permissions,
  policy,
  seeds,
  plugins: [
    rls({
      target: "sql",
      split: ["helpers", "seeds", "indexes", "policies", "hook"],
      seeds: { out: "supabase/migrations/" },
    }),
  ],
  rls: {
    dialect: "supabase",
    authorize: "database",
    actions: { manage: "none" },
    scopeTypes: { tenant: "text" },
    tables: { projects: "projects", organizations: false },
    membershipSources: memberships,
    suspension: {
      users: { table: "profiles", id: "id", disabledAt: "disabled_at" },
      scopes: {
        organization: {
          table: "organizations",
          id: "id",
          disabledAt: "disabled_at",
        },
      },
    },
    roles: { table: "public.platform_roles", user: "user_id", role: "role" },
    approvals: {
      delegations: true,
      managers: {
        table: "public.reporting_lines",
        user: "user_id",
        manager: "manager_id",
        tenant: "organization_id",
      },
    },
  },
  supabase: { hook: { memberships } },
});
