"use server";

import { decideCustomRole } from "permdock";
import { z } from "zod";

import { getPermDock, protectAction } from "../../permdock/server.ts";
import { permissions } from "../../policy.ts";

const input = z.object({ organizationId: z.uuid(), name: z.string().min(1) });

export const saveCustomRole = protectAction(permissions.roles.manage, {
  input,
  tenant: (value) => value.organizationId,
})(async (value) => {
  const decision = decideCustomRole(
    await getPermDock({ tenant: value.organizationId, intent: "write" }),
    {
      name: value.name,
      tenant: value.organizationId,
      grants: [{ permission: permissions.quotes.read.key }],
    },
  );
  return { outcome: decision.outcome, name: value.name };
});
