import { allow, authenticated, definePolicy, role } from "permdock";

import { permissions } from "../oauth-scopes/permissions.ts";

const { task } = permissions;

export const policy = definePolicy(permissions, {
  roles: [role("owner", [allow([task.read, task.update])], { on: "tenant" })],
  scopes: { tenant: { key: "orgId" } },
  oauthScopes: {
    "mcp:read": [task.read],
    "mcp:write": [task.read, task.update],
  },
  delegations: [
    { from: authenticated(), to: "oauth-client", permissions: [task.read] },
    {
      from: authenticated(),
      to: { kind: "oauth-client", id: "docs" },
      permissions: [task.update],
    },
    {
      from: authenticated(),
      to: "oauth-client",
      permissions: [task.update],
      validUntil: "2999-01-01T00:00:00Z",
    },
  ],
  subject: () => null,
});
