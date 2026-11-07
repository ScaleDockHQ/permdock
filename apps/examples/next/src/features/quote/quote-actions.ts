"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { findQuote, removeQuote, setQuoteStatus } from "../../lib/store.ts";
import { protectAction, requirePermission } from "../../permdock/server.ts";
import { permissions } from "../../permissions.ts";
import { invalidateQuotes } from "./quote-cache.ts";

const quoteRef = z.object({ organization: z.string(), id: z.string() });

// Resolves to { ok: false, problem } on a refusal, so the form can show it.
export const approveQuote = protectAction(permissions.quote.approve, {
  input: quoteRef,
  data: async ({ organization, id }) => {
    const quote = await findQuote(organization, id);
    return quote;
  },
  tenant: ({ organization }) => organization,
})(({ organization }, { data }) => {
  setQuoteStatus(data.id, "approved");
  invalidateQuotes(organization);
  return data.id;
});

export async function deleteQuote(
  organization: string,
  id: string,
): Promise<void> {
  const quote = await findQuote(organization, id);
  if (quote === null) {
    return;
  }
  await requirePermission(permissions.quote.delete, quote, {
    tenant: organization,
  });
  removeQuote(quote.id);
  invalidateQuotes(organization);
  redirect(`/${organization}/quotes`);
}
