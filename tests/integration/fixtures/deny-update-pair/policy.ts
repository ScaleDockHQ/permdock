import type { Principal } from "permdock";

import {
  allow,
  anyone,
  definePermissions,
  definePolicy,
  deny,
  resource,
} from "permdock";
import { z } from "zod";

/** Anyone may read and update a doc, but never a locked one. */
export const permissions = definePermissions({
  doc: resource(z.object({ id: z.string(), locked: z.boolean() }), {
    id: "id",
    actions: ["read", "update"],
  }),
});

export const policy = definePolicy(permissions, {
  subject: (user: Principal | null) => user,
  grants: [
    allow(permissions.doc.read, { to: anyone() }),
    allow(permissions.doc.update, { to: anyone() }),
    deny(permissions.doc.update, { to: anyone(), where: { locked: true } }),
  ],
});
