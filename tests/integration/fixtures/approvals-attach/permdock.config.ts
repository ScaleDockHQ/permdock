export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    approvals: {
      table: "public.approvals",
      token: "permdock_token",
      body: "request",
      open: "attach",
      schema: "public",
      mirror: { status: "state", approvals: "approval_count" },
    },
  },
};
