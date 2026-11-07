import { membership } from "./sources.ts";

export default {
  permissions: "../named-scopes/policy.ts",
  policy: "../named-scopes/policy.ts",
  rls: { actions: { accept: "none", disable: "none", pay: "none" } },
  supabase: { hook: { memberships: [membership()], roles: false } },
};
