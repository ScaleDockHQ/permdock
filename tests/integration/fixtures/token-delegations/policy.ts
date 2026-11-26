import { allow, authenticated, definePolicy, role } from "permdock";

import { permissions } from "../oauth-scopes/permissions.ts";

const { task } = permissions;

export const policy = definePolicy(permissions, {
  roles: [role("owner", [allow([task.read, task.update])], { on: "tenant" })],
  scopes: { tenant: { key: "orgId" } },
  delegations: [
    { from: authenticated(), to: "oauth-client", permissions: [task.read] },
  ],
  subject: () => null,
});
