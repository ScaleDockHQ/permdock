import { notFound } from "next/navigation";

import { DataSource } from "../../../components/data-source.tsx";
import { organizationBySlug } from "../../organization/organization-queries.ts";
import { visibleQuotes } from "../quote-queries.ts";

/**
 * The rows RLS lets the caller read: every quote for an owner, one customer's
 * for a contact.
 */
export async function QuoteList(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  const quotes = await visibleQuotes(organization.id);
  return (
    <>
      <ul data-testid="quotes">
        {quotes.value.map((quote) => (
          <li key={quote.id} data-quote={quote.id}>
            {quote.title}: {quote.currency}{" "}
            {(quote.amount_minor / 100).toFixed(2)}
          </li>
        ))}
      </ul>
      <DataSource name="Quotes" loaded={quotes} />
    </>
  );
}

export function QuoteListSkeleton() {
  return (
    <ul aria-busy="true" data-testid="quotes-skeleton">
      <li>&nbsp;</li>
      <li>&nbsp;</li>
    </ul>
  );
}
