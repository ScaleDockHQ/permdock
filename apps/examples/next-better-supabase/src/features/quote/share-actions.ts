"use server";

import { sqlTransport } from "better-supabase/blocks";
import { createShareLinks } from "better-supabase/blocks/share-links";
import { z } from "zod";

import { postgres } from "../../lib/supabase/server.ts";
import { protectAction } from "../../permdock/server.ts";
import { permissions } from "../../policy.ts";

const createInput = z.object({ organizationId: z.uuid(), quoteId: z.uuid() });

function linksFor(tenant: string) {
  return createShareLinks({ transport: sqlTransport(postgres.admin), tenant });
}

/** The SQL function shares a subject only as the service role. */
export const createShareLink = protectAction(permissions.quotes.update, {
  input: createInput,
  tenant: (input) => input.organizationId,
})(async (input) => {
  const created = await linksFor(input.organizationId).create({
    subject: { type: "quote", id: input.quoteId },
  });
  return created.ok ? { id: created.data.id } : { id: null };
});

const revokeInput = z.object({ organizationId: z.uuid(), linkId: z.uuid() });

export const revokeShareLink = protectAction(permissions.quotes.update, {
  input: revokeInput,
  tenant: (input) => input.organizationId,
})(async (input) => {
  const revoked = await linksFor(input.organizationId).revoke(input.linkId);
  return { revoked: revoked.ok && revoked.data };
});
