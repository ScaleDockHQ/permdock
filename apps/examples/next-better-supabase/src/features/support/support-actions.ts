"use server";

import type { SettingsSource } from "permdock";

import { decideSupportSession } from "permdock";
import { supportPolicy } from "permdock/better-supabase";
import { z } from "zod";

import { getPermDock, protectAction } from "../../permdock/server.ts";
import { appPolicy, permissions } from "../../policy.ts";

const input = z.object({
  organizationId: z.uuid(),
  principal: z.uuid(),
  reason: z.string().min(1),
});

const readOnly: SettingsSource = {
  name: "support-read-only",
  settingsFor: () => ({ supportSessions: { readOnly: true, maxTtl: 3600 } }),
};

/**
 * The impersonation block's start check. Read-only sessions need no writable
 * set.
 */
export const authorizeSupport = supportPolicy({
  policy: appPolicy,
  approval: false,
});

export const startSupport = protectAction(permissions.impersonation.start, {
  input,
  tenant: (value) => value.organizationId,
})(async (value) => {
  const decision = await decideSupportSession(
    await getPermDock({ tenant: value.organizationId, intent: "write" }),
    {
      id: crypto.randomUUID(),
      principal: value.principal,
      tenant: value.organizationId,
      reason: value.reason,
    },
    { settings: readOnly },
  );
  return { outcome: decision.outcome, ready: typeof authorizeSupport };
});
