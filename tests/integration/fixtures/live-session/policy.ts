import { allow, definePolicy, role } from "permdock";

import { permissions } from "../rls-matrix/permissions.ts";

const { project } = permissions;

/** Admins read with any token; updating and deleting needs a session `auth.sessions` still holds. */
export const policy = definePolicy(permissions, {
  roles: [
    role(
      "admin",
      [
        allow(project.read),
        allow([project.update, project.delete], {
          where: { subject: { session: { live: true } } },
        }),
      ],
      { on: "tenant" },
    ),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
