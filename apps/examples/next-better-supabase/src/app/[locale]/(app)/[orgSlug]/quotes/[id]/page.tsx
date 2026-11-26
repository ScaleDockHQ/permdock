import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { QuoteDetail } from "../../../../../../features/quote/components/quote-detail.tsx";

export const instant = true;

export default function QuotePage(
  props: PageProps<"/[locale]/[orgSlug]/quotes/[id]">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug, id }) => (
        <QuoteDetail orgSlug={orgSlug} id={id} />
      ))}
    </Suspense>
  );
}
