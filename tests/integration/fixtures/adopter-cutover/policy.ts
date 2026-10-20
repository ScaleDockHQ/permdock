import { allow, definePolicy, role } from "permdock";

import { permissions } from "./permissions.ts";

const { invite, job } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role("owner", [allow([job.read, job.update, job.delete, job.create])], {
      on: "tenant",
      assignable: false,
    }),
    role(
      "admin",
      [allow([job.read, job.update, job.create, invite.create, invite.read])],
      {
        on: "tenant",
      },
    ),
    role("member", [allow([job.read, job.create])], { on: "tenant" }),
    role("support", [allow([job.read])], { assignable: true }),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
