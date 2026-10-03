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
 * One primary owner per organization that only moves by transfer, at most two
 * approvers, and a ledger reviewer only staff memberships may hold.
 */
export const permissions = definePermissions({
  payment: resource(z.object({ id: z.string(), org_id: z.string() }), {
    id: "id",
    actions: ["read", "approve"],
    relations: { org: { field: "org_id", memberOf: "org" } },
  }),
  ledger: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read"],
  }),
});

export const policy = definePolicy(permissions, {
  scopes: { org: { key: "org_id" } },
  subject: (user: Principal | null) => user,
  roles: [
    role("primary", [allow(permissions.payment.approve)], {
      on: "org",
      min: 1,
      max: 1,
      transferOnly: true,
      assigns: ["primary", "approver"],
    }),
    role("approver", [allow(permissions.payment.read)], { on: "org", max: 2 }),
    role("reviewer", [allow(permissions.ledger.read)], {
      on: permissions.ledger,
      for: ["staff"],
    }),
  ],
});
