import { Suspense } from "react";

import { PageHeader } from "@/components/page-header.tsx";
import { ListSkeleton, QuoteList } from "@/components/quotes/quote-list.tsx";

export const instant = true;

export default function Quotes(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quotes"
        description="Every quote in this organization. Each link prefetches the quote and the actions your role allows."
      />
      <Suspense fallback={<ListSkeleton />}>
        <QuoteList params={props.params} prefix="" />
      </Suspense>
    </div>
  );
}
