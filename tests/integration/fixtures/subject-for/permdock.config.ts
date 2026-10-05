import { sources, suspension } from "../supabase-sources/sources.ts";

/** A backend that reads a stored user's subject through `subject_for`. */
export default {
  permissions: "../named-scopes/policy.ts",
  policy: "../named-scopes/policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",
    tenantType: "text",
    customRoles: true,
    membershipSources: sources(),
    suspension,
  },
  supabase: {
    hook: { memberships: sources(), suspension },
  },
};
