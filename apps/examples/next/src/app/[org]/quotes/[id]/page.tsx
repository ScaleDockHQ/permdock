import { Suspense } from 'react';

import { QuoteSkeleton, QuoteView } from '../../../quotes.tsx';

export const instant = true;

export default function QuotePage(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  return (
    <section>
      <h1>Quote</h1>
      <Suspense fallback={<QuoteSkeleton />}>
        <QuoteView params={props.params} />
      </Suspense>
    </section>
  );
}
