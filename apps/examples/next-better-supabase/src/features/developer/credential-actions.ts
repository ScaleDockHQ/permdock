"use server";

import { decideCredential } from "permdock";
import { z } from "zod";

import { getPermDock, protectAction } from "../../permdock/server.ts";
import { tenantSettings } from "../../permdock/settings.ts";
import { permissions } from "../../policy.ts";

const input = z.object({ organizationId: z.uuid() });

export const issueApiKey = protectAction(permissions.api_keys.manage, {
  input,
  tenant: (value) => value.organizationId,
})(async (value) => {
  const decision = await decideCredential(
    await getPermDock({ tenant: value.organizationId, intent: "write" }),
    {
      kind: "user",
      id: crypto.randomUUID(),
      tenant: value.organizationId,
      permissions: [permissions.quotes.read],
    },
    { settings: tenantSettings },
  );
  return { outcome: decision.outcome };
});

export const issueServiceAccount = protectAction(
  permissions.service_accounts.manage,
  { input, tenant: (value) => value.organizationId },
)(async (value) => {
  const decision = await decideCredential(
    await getPermDock({ tenant: value.organizationId, intent: "write" }),
    {
      kind: "service",
      id: crypto.randomUUID(),
      tenant: value.organizationId,
      roles: ["member"],
      permissions: [permissions.quotes.read],
    },
  );
  return { outcome: decision.outcome };
});
