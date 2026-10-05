import type { Principal } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/** A staff role read through a membership table that stores no kind column. */
export const permissions = definePermissions({
  doc: resource(z.object({ id: z.string(), org_id: z.string() }), {
    id: "id",
    actions: ["read"],
    relations: { org: { field: "org_id", memberOf: "org" } },
  }),
});

export const policy = definePolicy(permissions, {
  scopes: { org: { key: "org_id" } },
  subject: (user: Principal | null) => user,
  roles: [
    role("admin", [allow(permissions.doc.read)], {
      on: "org",
      for: ["staff"],
    }),
  ],
});
