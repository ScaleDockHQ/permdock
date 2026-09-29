import Link from 'next/link';
import { Suspense } from 'react';

import { QuoteSkeleton, QuoteView } from '../../../../quotes.tsx';

export const instant = true;

async function Back(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  return (
    <Link href={`/portal/${org}`} prefetch>
      All quotes
    </Link>
  );
}

export default function PortalQuote(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  return (
    <section>
      <Suspense fallback={null}>
        <Back params={props.params} />
      </Suspense>
      <Suspense fallback={<QuoteSkeleton />}>
        <QuoteView params={props.params} />
      </Suspense>
    </section>
  );
}
