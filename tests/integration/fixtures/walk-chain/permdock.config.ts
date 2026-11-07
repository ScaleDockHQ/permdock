/** A self-parented employee table walked from the caller's own row. */
export default {
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    idTypes: { employee: "text" },
    approvals: { delegations: true },
    tables: {
      employee: { table: "public.employee", walk: "recursive", user: "userId" },
    },
  },
};
