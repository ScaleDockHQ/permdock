import type { Principal } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from "permdock";
import { z } from "zod";

export const permissions = definePermissions({
  doc: resource(z.object({ id: z.string(), org_id: z.string() }), {
    id: "id",
    actions: ["read", "update", "delete"],
    relations: { org: { field: "org_id", memberOf: "org" } },
  }),
});

/**
 * Static grants only: allows, a deny that overrides an allow, and a role with
 * one action.
 */
export const policy = definePolicy(permissions, {
  scopes: { org: { key: "org_id" } },
  subject: (user: Principal | null) => user,
  roles: [
    role(
      "admin",
      [
        allow(permissions.doc.read),
        allow(permissions.doc.update),
        allow(permissions.doc.delete),
      ],
      { on: "org", for: ["staff"] },
    ),
    role(
      "editor",
      [
        allow(permissions.doc.read),
        allow(permissions.doc.update),
        allow(permissions.doc.delete),
        deny(permissions.doc.delete),
      ],
      { on: "org", for: ["staff"] },
    ),
    role("viewer", [allow(permissions.doc.read)], {
      on: "org",
      for: ["staff"],
    }),
  ],
});
