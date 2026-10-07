import { Suspense } from "react";

import { ListSkeleton, QuoteList } from "../../quotes.tsx";

export const instant = true;

export default function Quotes(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  return (
    <section>
      <h1 data-testid="page-title">Quotes</h1>
      <Suspense fallback={<ListSkeleton />}>
        <QuoteList params={props.params} prefix="" />
      </Suspense>
    </section>
  );
}
