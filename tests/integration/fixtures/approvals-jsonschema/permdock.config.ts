/** The approval store with its body checked by pg_jsonschema, for the supabase/postgres image. */
export default {
  permissions: "../custom-role-writes/permissions.ts",
  policy: "../custom-role-writes/policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    approvals: true,
    jsonSchema: true,
  },
};
