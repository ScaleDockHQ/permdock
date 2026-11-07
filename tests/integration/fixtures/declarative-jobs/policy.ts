import { allow, definePolicy, role } from "permdock";

import { permissions } from "./permissions.ts";

export const policy = definePolicy(permissions, {
  scopes: {
    tenant: { key: "organizationId" },
    team: { key: "teamId", within: "tenant" },
  },
  subject: () => null,
  roles: [
    role(
      "member",
      [allow(permissions.job.read), allow(permissions.jobParty.read)],
      { on: "tenant" },
    ),
  ],
});
