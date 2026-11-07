import { Protected } from "permdock/react";
import { Suspense } from "react";

import {
  QuoteList,
  QuoteListSkeleton,
} from "../../../../../features/quote/components/quote-list.tsx";
import { permissions } from "../../../../../policy.ts";

export const instant = true;

export default function QuotesPage(
  props: PageProps<"/[locale]/[orgSlug]/quotes">,
) {
  return (
    <section>
      <h1 data-testid="page-title">Quotes</h1>
      <Protected
        permission={permissions.quotes.list}
        pending={<QuoteListSkeleton />}
        denied={<p>Only owners can see every quote.</p>}
      >
        <Suspense fallback={<QuoteListSkeleton />}>
          {props.params.then(({ orgSlug }) => (
            <QuoteList orgSlug={orgSlug} />
          ))}
        </Suspense>
      </Protected>
    </section>
  );
}
