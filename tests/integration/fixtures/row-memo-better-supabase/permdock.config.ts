import base from "../row-memo/permdock.config.ts";

export default {
  ...base,
  permissions: "../row-memo/policy.ts",
  policy: "../row-memo/policy.ts",
  rls: { ...base.rls, memo: "better-supabase" },
};
