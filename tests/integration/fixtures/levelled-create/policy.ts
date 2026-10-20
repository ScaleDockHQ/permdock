import { allow, definePolicy, role } from "permdock";

import { permissions } from "./permissions.ts";

const { job } = permissions;

export const policy = definePolicy(permissions, {
  roles: [role("admin", [allow([job.read, job.create])], { on: "tenant" })],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
