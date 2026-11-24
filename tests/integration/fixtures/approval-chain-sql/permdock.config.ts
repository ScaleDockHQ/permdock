/** Manager approvers over a self-referencing employees table. */
export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    actions: { assignRole: "none" },
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    approvals: {
      delegations: true,
      managers: {
        table: "public.employees",
        id: "id",
        reportsTo: "manager_employee_id",
        user: "user_id",
        tenant: "org",
        active: { status: "status", inactive: ["ended"] },
      },
    },
  },
};
