import { allow, definePolicy, deny, principal, role } from "permdock";

import { permissions } from "./permissions.ts";

const { project, task } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role("auditor", [allow([project.read, task.read])]),
    role(
      "admin",
      [
        allow([project.read, project.update, project.delete]),
        allow([project.list, project.create]),
        allow([task.read, task.update, task.delete]),
        allow([task.list, task.create]),
      ],
      { on: "tenant" },
    ),
    role(
      "member",
      [
        allow([project.read, task.read]),
        allow([project.list, task.list, task.create]),
        allow(project.update, { where: { ownerId: principal.id } }),
        allow([task.update, task.delete], {
          where: { authorId: principal.id },
        }),
        deny(task.update, { where: { locked: true } }),
      ],
      { on: "tenant" },
    ),
    role("viewer", [allow([project.read, task.read])], { on: "tenant" }),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
