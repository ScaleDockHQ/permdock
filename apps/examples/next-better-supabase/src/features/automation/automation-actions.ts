"use server";

import { decideAutomation } from "permdock";
import { z } from "zod";

import { getPermDock, protectAction } from "../../permdock/server.ts";
import { permissions } from "../../policy.ts";

const input = z.object({ organizationId: z.uuid() });

export const publishAutomation = protectAction(
  permissions.automations.publish,
  { input, tenant: (value) => value.organizationId },
)(async (value) => {
  const decision = await decideAutomation(
    await getPermDock({ tenant: value.organizationId, intent: "write" }),
    {
      id: crypto.randomUUID(),
      version: 1,
      tenant: value.organizationId,
      operations: [
        { name: "quotes.read", permission: permissions.quotes.read },
      ],
    },
  );
  return { outcome: decision.outcome };
});
