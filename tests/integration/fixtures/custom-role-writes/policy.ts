import { allow, definePolicy, principal, role } from "permdock";

import { permissions } from "./permissions.ts";

const { job, member } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role("admin", [allow([job.read, job.update])], { on: "tenant" }),
    role(
      "manager",
      [
        allow(job.read),
        allow(job.update, { where: { ownerId: principal.id } }),
      ],
      { on: "tenant" },
    ),
    role("steward", [allow(member.assignRole)], {
      on: "tenant",
      assignable: false,
    }),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
