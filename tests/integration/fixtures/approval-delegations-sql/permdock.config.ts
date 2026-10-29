/**
 * The generated approval store with out-of-office covers and tenant approval
 * policies.
 */
export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    approvals: { delegations: true, tenantPolicies: { manage: "job.update" } },
  },
};
