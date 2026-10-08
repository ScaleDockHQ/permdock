import { sources } from "../permdock.config.ts";

export default {
  permissions: "../../policy.ts",
  policy: "../../policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "database",
  },
  supabase: { hook: { memberships: sources() } },
};
