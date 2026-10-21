/**
 * The generated approval store next to the helpers; plain Postgres has no
 * pg_jsonschema, so `auto` adds no check.
 */
export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    approvals: true,
    jsonSchema: "auto",
  },
};
