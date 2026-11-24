import type { Principal } from "../../src/core/subject.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "../../src/index.ts";

export const tenantPermissions = definePermissions({
  project: resource({ collection: ["create"] }),
});

const roles = defineRoles({ member: { on: "tenant" } });

/** One tenant scope; `member` may create a project in the tenant it holds. */
export const tenantPolicy = definePolicy(
  { permissions: tenantPermissions, roles },
  {
    scopes: { tenant: { key: "orgId" } },
    subject: (user: Principal | null) => user,
    roles: [role(roles.member, [allow(tenantPermissions.project.create)])],
  },
);

/** `acme` is the caller's tenant `o1`; `globex` is `o2`, which it does not hold. */
export const tenantSlugs: Readonly<Record<string, string>> = {
  acme: "o1",
  globex: "o2",
};

export const tenantCaller: Principal = {
  id: "u1",
  tenant: "o1",
  memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
};
