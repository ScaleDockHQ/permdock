import { Suspense } from "react";

import { PageHeader } from "@/components/page-header.tsx";
import { QuoteList } from "@/components/quotes/quote-list.tsx";
import { ListSkeleton } from "@/components/quotes/quote-states.tsx";

export const instant = true;

export default function PortalQuotes(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Your quotes"
        description="Quotes sent to your company. Drafts stay hidden until they are sent."
      />
      <Suspense fallback={<ListSkeleton />}>
        <QuoteList params={props.params} prefix="/portal" />
      </Suspense>
    </div>
  );
}
