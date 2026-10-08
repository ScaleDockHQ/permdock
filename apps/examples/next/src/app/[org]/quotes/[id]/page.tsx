import { Suspense } from "react";

import { PageHeader } from "@/components/page-header.tsx";
import { QuoteSkeleton } from "@/components/quotes/quote-states.tsx";
import { QuoteView } from "@/components/quotes/quote-view.tsx";

import { DeleteBoundary } from "./delete-boundary.tsx";
import { DeleteZone, DeleteZoneSkeleton } from "./delete-zone.tsx";

export const instant = true;

export default function QuotePage(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quote"
        description="The approve button comes from the prefetched private cache; the delete zone checks at request time, so it streams in after the store read."
      />
      <Suspense fallback={<QuoteSkeleton />}>
        <QuoteView params={props.params} />
      </Suspense>
      <DeleteBoundary>
        <Suspense fallback={<DeleteZoneSkeleton />}>
          <DeleteZone params={props.params} />
        </Suspense>
      </DeleteBoundary>
    </div>
  );
}
