import { allow, definePolicy, role } from "permdock";

import { permissions } from "./permissions.ts";

const { task } = permissions;

export const policy = definePolicy(permissions, {
  roles: [role("owner", [allow([task.read, task.update])], { on: "tenant" })],
  scopes: { tenant: { key: "orgId" } },
  oauthScopes: {
    "mcp:read": [task.read],
    "mcp:write": [task.read, task.update],
  },
  subject: () => null,
});
