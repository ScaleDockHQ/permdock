import { sources, suspension } from "../supabase-sources/sources.ts";

/** The hook with custom roles in tables, for the token shape and size tests. */
export default {
  permissions: "../named-scopes/policy.ts",
  policy: "../named-scopes/policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    actions: { accept: "none", disable: "none", pay: "none" },
    scopeTypes: { tenant: "text" },
    customRoles: true,
    membershipSources: sources(),
    suspension,
  },
  supabase: { hook: { memberships: sources(), suspension } },
};
