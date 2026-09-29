import { Suspense } from 'react';

import { ListSkeleton, QuoteList } from '../../quotes.tsx';

export const instant = true;

export default function PortalQuotes(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  return (
    <section>
      <h1>Your quotes</h1>
      <Suspense fallback={<ListSkeleton />}>
        <QuoteList params={props.params} prefix="/portal" />
      </Suspense>
    </section>
  );
}
