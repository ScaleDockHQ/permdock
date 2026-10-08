import { sources, suspension } from "../permdock.config.ts";

export default {
  permissions: "../../policy.ts",
  policy: "../../policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
    suspension,
  },
  supabase: { hook: { memberships: sources({ suspension }) } },
};
