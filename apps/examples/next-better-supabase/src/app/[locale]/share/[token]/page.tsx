import { Suspense } from "react";

import { sharedQuote } from "../../../../lib/share.ts";

function SharedQuoteSkeleton() {
  return (
    <p aria-busy="true" data-testid="shared-quote-skeleton">
      &nbsp;
    </p>
  );
}

/** Whoever holds the link reads this one quote, without an account. */
async function SharedQuote(props: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await props.params;
  const quote = await sharedQuote(token);
  if (quote === null) {
    return (
      <p data-testid="shared-quote-invalid">
        This link is invalid, revoked or expired. Ask the sender for a new one.
      </p>
    );
  }
  return (
    <p data-testid="shared-quote" data-quote={quote.id}>
      {quote.title}: {quote.currency} {(quote.amount_minor / 100).toFixed(2)}
    </p>
  );
}

export default function SharePage(props: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  return (
    <section>
      <h1 data-testid="page-title">Shared quote</h1>
      <Suspense fallback={<SharedQuoteSkeleton />}>
        <SharedQuote params={props.params} />
      </Suspense>
    </section>
  );
}
