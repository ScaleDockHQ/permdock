"use server";

import { decideRoleChange } from "permdock";
import { z } from "zod";

import { getPermDock, protectAction } from "../../permdock/server.ts";
import { permissions } from "../../policy.ts";

const change = z.object({
  organizationId: z.uuid(),
  userId: z.uuid(),
  role: z.string().min(1),
  holders: z.number().int().nonnegative(),
});

/** Refuses removing the last owner: the owner role has `min: 1`. */
export const transferOwnership = protectAction(
  permissions.organization.transfer_ownership,
  { input: change, tenant: (input) => input.organizationId },
)(async (input) => {
  const decision = decideRoleChange(
    await getPermDock({ tenant: input.organizationId, intent: "write" }),
    {
      kind: "transfer",
      role: input.role,
      scope: "organization",
      id: input.organizationId,
      holders: input.holders,
      target: { id: input.userId, roles: ["owner"] },
    },
  );
  return { outcome: decision.outcome };
});
