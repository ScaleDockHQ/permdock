import { Suspense } from "react";

import { PageHeader } from "@/components/page-header.tsx";

import { DeleteBoundary } from "../../../../features/quote/components/delete-boundary.tsx";
import {
  DeleteZone,
  DeleteZoneSkeleton,
} from "../../../../features/quote/components/delete-zone.tsx";
import {
  QuoteView,
  QuoteViewSkeleton,
} from "../../../../features/quote/components/quote-view.tsx";

export const instant = true;

export default function QuotePage(props: PageProps<"/[org]/quotes/[id]">) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quote"
        description="The approve button comes from the prefetched private cache; the delete zone checks at request time, so it streams in after the store read."
      />
      <Suspense fallback={<QuoteViewSkeleton />}>
        {props.params.then(({ org, id }) => (
          <QuoteView organization={org} id={id} />
        ))}
      </Suspense>
      <DeleteBoundary>
        <Suspense fallback={<DeleteZoneSkeleton />}>
          {props.params.then(({ org, id }) => (
            <DeleteZone organization={org} id={id} />
          ))}
        </Suspense>
      </DeleteBoundary>
    </div>
  );
}
