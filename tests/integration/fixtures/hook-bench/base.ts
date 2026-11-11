import { tableMembershipSource } from "permdock/supabase";

const memberships = [tableMembershipSource({ table: "memberships" })];

/**
 * The hook `scripts/hook-bench.ts` times: `database` mode, one membership table
 * and no suspension table, so the refresh fast path compiles wherever the
 * memberships claim is on.
 */
export function benchConfig(hook: Readonly<Record<string, unknown>>) {
  return {
    permissions: "../../named-scopes/policy.ts",
    policy: "../../named-scopes/policy.ts",
    rls: {
      dialect: "supabase",
      authorize: "database",
      actions: { accept: "none", disable: "none", pay: "none" },
      scopeTypes: { tenant: "text" },
      membershipSources: memberships,
    },
    supabase: { hook: { memberships, ...hook } },
  };
}
