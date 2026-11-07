import { Protected } from "permdock/react";
import { Suspense } from "react";

import {
  QuoteList,
  QuoteListSkeleton,
} from "../../../../../../features/quote/components/quote-list.tsx";
import { permissions } from "../../../../../../policy.ts";

export const instant = true;

export default function PortalQuotes(
  props: PageProps<"/[locale]/portal/[orgSlug]/quotes">,
) {
  return (
    <section>
      <h1 data-testid="page-title">Your quotes</h1>
      <Protected
        permission={permissions.quotes.list}
        pending={<QuoteListSkeleton />}
        denied={<p>Sign in as a customer contact to see quotes.</p>}
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
