/** The approval store adopted onto the app's own approvals table, mirroring a few fields into its columns. */
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
      mirror: {
        status: "state",
        tenant: "organization_id",
        principalId: "requested_by",
        approvals: "approval_count",
        expiresAt: "expires_at",
      },
    },
  },
};
