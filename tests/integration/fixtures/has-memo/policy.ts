import { allow, definePolicy, principal, role } from "permdock";

import { permissions } from "../rls-custom-roles/permissions.ts";

const { board, project, task } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role("support", [allow([project.read, task.read, board.read])], {
      assignable: true,
    }),
    role(
      "member",
      [
        allow([project.read, task.read]),
        allow(project.update, { where: { ownerId: principal.id } }),
      ],
      { on: "tenant" },
    ),
    role("lead", [allow([board.read, board.update])], { on: "team" }),
  ],
  scopes: {
    tenant: { key: "orgId" },
    team: { key: "teamId", within: "tenant" },
  },
  subject: () => null,
});
