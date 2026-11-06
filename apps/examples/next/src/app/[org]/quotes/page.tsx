import { Suspense } from "react";

import { PageHeader } from "@/components/page-header.tsx";

import {
  QuoteList,
  QuoteListSkeleton,
} from "../../../features/quote/components/quote-list.tsx";

export const instant = true;

export default function Quotes(props: PageProps<"/[org]/quotes">) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quotes"
        description="Every quote in this organization. Each link prefetches the quote and the actions your role allows."
      />
      <Suspense fallback={<QuoteListSkeleton />}>
        {props.params.then(({ org }) => (
          <QuoteList organization={org} prefix="" />
        ))}
      </Suspense>
    </div>
  );
}
