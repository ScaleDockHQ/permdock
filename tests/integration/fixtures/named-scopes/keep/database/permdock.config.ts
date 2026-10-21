import { memberships, sources, suspension } from "../permdock.config.ts";

export default {
  permissions: "../../policy.ts",
  policy: "../../policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    suspension,
    memberships,
  },
  supabase: { hook: { memberships: sources } },
};
