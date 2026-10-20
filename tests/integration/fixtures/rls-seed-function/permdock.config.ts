import base from "../rls-custom-roles/permdock.config.ts";

export default {
  ...base,
  permissions: "../rls-custom-roles/permissions.ts",
  policy: "../rls-custom-roles/policy.ts",
  rls: { ...base.rls, seeds: "function" },
};
