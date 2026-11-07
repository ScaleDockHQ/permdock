import { allow, definePolicy, role } from "permdock";

import { permissions } from "./permissions.ts";

export const policy = definePolicy(permissions, {
  scopes: {
    tenant: { key: "organization_id" },
    team: { key: "team_id", within: "tenant" },
  },
  subject: () => null,
  roles: [
    role("member", [allow(permissions.jobs.read)], {
      on: "tenant",
      assignable: true,
    }),
    role(
      "staff",
      [allow(permissions.jobs.read), allow(permissions.platformRole.manage)],
      { assignable: false },
    ),
    role("support", [allow(permissions.jobs.read)], { assignable: true }),
  ],
});
