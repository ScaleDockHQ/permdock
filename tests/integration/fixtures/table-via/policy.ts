import type { Principal } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/** A table keyed by its environment, whose organization the environments table knows. */
export const permissions = definePermissions({
  deploy: resource(z.object({ id: z.string(), org_id: z.string() }), {
    id: "id",
    actions: ["read"],
    relations: { org: { field: "org_id", memberOf: "org" } },
  }),
});

export const policy = definePolicy(permissions, {
  scopes: { org: { key: "org_id" } },
  subject: (user: Principal | null) => user,
  roles: [role("admin", [allow(permissions.deploy.read)], { on: "org" })],
});
