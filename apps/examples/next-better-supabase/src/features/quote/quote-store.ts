import "server-only";
import type { QuoteRecord } from "./quote-record.ts";

import { bsb } from "../../lib/supabase/server.ts";
import { isQuoteStatus } from "./quote-record.ts";

export type { QuoteRecord };

function quoteOf(row: {
  readonly id: string;
  readonly organization_id: string;
  readonly customer_id: string;
  readonly title: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly status: string;
  readonly team_id: string | null;
}): QuoteRecord | null {
  if (!isQuoteStatus(row.status)) {
    return null;
  }
  return { ...row, status: row.status };
}

/** The quote RLS lets this caller read, or null. */
export async function quoteById(id: string): Promise<QuoteRecord | null> {
  const { supabase } = await bsb.cached();
  const { data } = await supabase
    .from("quotes")
    .select(
      "id, organization_id, customer_id, title, amount_minor, currency, status, team_id",
    )
    .eq("id", id)
    .maybeSingle();
  return data === null ? null : quoteOf(data);
}

export async function insertQuote(input: {
  readonly organizationId: string;
  readonly customerId: string;
  readonly title: string;
  readonly amountMinor: number;
  readonly currency: string;
}): Promise<string> {
  const { supabase } = await bsb.cached();
  const id = crypto.randomUUID();
  const { error } = await supabase
    .from("quotes")
    .insert({
      id,
      organization_id: input.organizationId,
      customer_id: input.customerId,
      title: input.title,
      amount_minor: input.amountMinor,
      currency: input.currency,
      status: "draft",
    });
  if (error !== null) {
    throw new Error(error.message);
  }
  return id;
}

export async function patchQuote(
  id: string,
  patch: { readonly title?: string; readonly status?: QuoteRecord["status"] },
): Promise<void> {
  const { supabase } = await bsb.cached();
  const { error } = await supabase.from("quotes").update(patch).eq("id", id);
  if (error !== null) {
    throw new Error(error.message);
  }
}

export async function removeQuote(id: string): Promise<void> {
  const { supabase } = await bsb.cached();
  const { error } = await supabase.from("quotes").delete().eq("id", id);
  if (error !== null) {
    throw new Error(error.message);
  }
}
