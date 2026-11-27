import { sources, suspension } from "../centrakit/sources.ts";

/**
 * CentraKit's approvals in database mode: manager approvers, out-of-office
 * covers and no store, for the per-request and set approver checks.
 */
export default {
  permissions: "../centrakit/policy.ts",
  policy: "../centrakit/policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    scopeTypes: { tenant: "uuid" },
    suspension,
    approvals: {
      delegations: true,
      managers: {
        table: "public.reporting_lines",
        user: "user_id",
        manager: "manager_id",
        tenant: "organization_id",
      },
      store: false,
    },
  },
  supabase: { hook: { memberships: sources(), suspension } },
};
