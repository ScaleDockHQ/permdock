import { allow, definePolicy, role } from "permdock";

import { permissions } from "./permissions.ts";

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("member", [allow(permissions.employee.read)], { on: "tenant" })],
});
