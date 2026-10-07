import { Protected } from "permdock/react";
import { Suspense } from "react";

import { permissions } from "../../../../../../policy.ts";
import { Quotes, QuotesSkeleton } from "../../../../quotes.tsx";

export const instant = true;

export default function PortalQuotes(props: {
  readonly params: Promise<{ readonly orgSlug: string }>;
}) {
  return (
    <section>
      <h1 data-testid="page-title">Your quotes</h1>
      <Protected
        permission={permissions.quotes.list}
        pending={<QuotesSkeleton />}
        fallback={<p>Sign in as a customer contact to see quotes.</p>}
      >
        <Suspense fallback={<QuotesSkeleton />}>
          <Quotes params={props.params} />
        </Suspense>
      </Protected>
    </section>
  );
}
