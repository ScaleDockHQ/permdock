import { sources } from "../permdock.config.ts";

export default {
  permissions: "../../policy.ts",
  policy: "../../policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    actions: { accept: "none", disable: "none", pay: "none" },
  },
  supabase: { hook: { memberships: sources() } },
};
