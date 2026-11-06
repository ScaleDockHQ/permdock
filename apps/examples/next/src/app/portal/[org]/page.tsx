import { Suspense } from "react";

import { PageHeader } from "@/components/page-header.tsx";

import {
  QuoteList,
  QuoteListSkeleton,
} from "../../../features/quote/components/quote-list.tsx";

export const instant = true;

export default function PortalQuotes(props: PageProps<"/portal/[org]">) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Your quotes"
        description="Quotes sent to your company. Drafts stay hidden until they are sent."
      />
      <Suspense fallback={<QuoteListSkeleton />}>
        {props.params.then(({ org }) => (
          <QuoteList organization={org} prefix="/portal" />
        ))}
      </Suspense>
    </div>
  );
}
