import { memberships, sources, suspension } from "../permdock.config.ts";

export default {
  permissions: "../../policy.ts",
  policy: "../../policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    actions: { accept: "none", disable: "none", pay: "none" },
    suspension,
    memberships,
  },
  supabase: { hook: { memberships: sources } },
};
