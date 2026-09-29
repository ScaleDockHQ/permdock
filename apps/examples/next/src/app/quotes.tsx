import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { Quote } from '../permissions.ts';

import { quoteAccess, visibleQuotes } from '../lib/access.ts';
import { customers } from '../lib/store.ts';
import { approveQuote } from './actions.ts';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function customerName(quote: Quote): string {
  return (
    customers.find((customer) => customer.id === quote.customer_id)?.name ??
    quote.customer_id
  );
}

export function ListSkeleton() {
  return (
    <ul aria-busy="true" data-testid="quotes-skeleton">
      <li>&nbsp;</li>
      <li>&nbsp;</li>
    </ul>
  );
}

/** Links use `prefetch={true}`: the prefetch resolves the quote's params and its private access check. */
export async function QuoteList(props: {
  readonly params: Promise<{ readonly org: string }>;
  readonly prefix: '' | '/portal';
}) {
  const { org } = await props.params;
  const quotes = await visibleQuotes(org);
  if (quotes.length === 0) {
    return <p data-testid="quotes-empty">No quotes to show yet.</p>;
  }
  return (
    <ul data-testid="quotes">
      {quotes.map((quote) => (
        <li key={quote.id}>
          <Link
            href={`${props.prefix}/${org}/quotes/${quote.id}`}
            prefetch={true}
            data-quote={quote.id}
          >
            {quote.title}
          </Link>{' '}
          <span>
            {customerName(quote)} · {quote.status} · {money.format(quote.total)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function QuoteSkeleton() {
  return <article aria-busy="true" data-testid="quote-skeleton" />;
}

export async function QuoteView(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  const { org, id } = await props.params;
  const access = await quoteAccess(org, id);
  const quote = access.quote;
  if (quote === null) {
    notFound();
  }
  return (
    <article data-testid="quote" data-quote={quote.id}>
      <h2>{quote.title}</h2>
      <dl>
        <dt>Customer</dt>
        <dd>{customerName(quote)}</dd>
        <dt>Status</dt>
        <dd data-testid="quote-status">{quote.status}</dd>
        <dt>Total</dt>
        <dd>{money.format(quote.total)}</dd>
      </dl>
      <div data-testid="quote-actions">
        {access.approve ? (
          <form action={approveQuote.bind(null, org, quote.id)}>
            <button type="submit" data-action="approve">
              Approve quote
            </button>
          </form>
        ) : null}
      </div>
    </article>
  );
}
