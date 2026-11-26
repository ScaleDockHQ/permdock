"use server";

import { z } from "zod";

import { postgres } from "../../lib/supabase/server.ts";
import { protectAction } from "../../permdock/server.ts";
import { permissions } from "../../policy.ts";

const input = z.object({
  organizationId: z.uuid(),
  entryId: z.string().min(1),
});

export const revertAudit = protectAction(permissions.audit.revert, {
  input,
  tenant: (value) => value.organizationId,
})(async (value) => {
  await postgres.admin.queryRaw(
    "select better_supabase.revert_audit_entries($1::text[])",
    [[value.entryId]],
  );
  return { entryId: value.entryId };
});
