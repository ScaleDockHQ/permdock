/**
 * The generated approval store next to the helpers. Plain Postgres has no
 * pg_jsonschema, so the check stays off.
 */
export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    approvals: true,
    jsonSchema: false,
  },
};
