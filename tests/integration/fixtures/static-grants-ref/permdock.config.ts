import config from "../static-grants-inline/permdock.config.ts";

export default {
  ...config,
  permissions: "../static-grants-inline/policy.ts",
  policy: "../static-grants-inline/policy.ts",
  rls: { ...config.rls, staticGrants: "ref" },
};
