import config from "../constant-via/permdock.config.ts";

export default {
  ...config,
  permissions: "../constant-via/policy.ts",
  policy: "../constant-via/policy.ts",
  rls: { ...config.rls, seeds: "view" },
};
