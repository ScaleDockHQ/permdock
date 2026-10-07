import { notFound } from "next/navigation";

import { organizationBySlug, visibleQuotes } from "../../lib/access.ts";

export function QuotesSkeleton() {
  return (
    <ul aria-busy="true" data-testid="quotes-skeleton">
      <li>&nbsp;</li>
      <li>&nbsp;</li>
    </ul>
  );
}

/** The rows RLS lets the caller read: every quote for an owner, one customer's for a contact. */
export async function Quotes(props: {
  readonly params: Promise<{ readonly orgSlug: string }>;
}) {
  const { orgSlug } = await props.params;
  const organization = await organizationBySlug(orgSlug);
  if (organization === null) {
    notFound();
  }
  const quotes = await visibleQuotes(organization.id);
  return (
    <ul data-testid="quotes">
      {quotes.map((quote) => (
        <li key={quote.id} data-quote={quote.id}>
          {quote.title}: {quote.currency}{" "}
          {(quote.amount_minor / 100).toFixed(2)}
        </li>
      ))}
    </ul>
  );
}
