import type { Principal } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/**
 * A project role that reaches tasks, read through a memberships table whose
 * columns share their names with the rows it guards (`id`, `project_id`).
 */
export const permissions = definePermissions({
  project: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read"],
  }),
  task: resource(z.object({ id: z.string(), project_id: z.string() }), {
    id: "id",
    actions: ["read"],
    parent: { field: "project_id", resource: "project" },
  }),
});

export const policy = definePolicy(permissions, {
  subject: (user: Principal | null) => user,
  roles: [
    role(
      "viewer",
      [allow(permissions.project.read), allow(permissions.task.read)],
      { on: permissions.project },
    ),
  ],
});
