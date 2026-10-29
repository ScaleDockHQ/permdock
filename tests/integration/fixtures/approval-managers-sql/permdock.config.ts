/** The generated approval store with manager approvers and out-of-office covers. */
export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    approvals: {
      delegations: true,
      managers: {
        table: "public.reporting_lines",
        user: "user_id",
        manager: "manager_id",
      },
    },
  },
};
