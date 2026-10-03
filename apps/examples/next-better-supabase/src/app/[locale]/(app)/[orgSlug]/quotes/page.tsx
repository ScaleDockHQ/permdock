import { Protected } from "permdock/react";
import { Suspense } from "react";

import { permissions } from "../../../../../policy.ts";
import { Quotes } from "../../../quotes.tsx";

export const instant = true;

export default function QuotesPage(props: {
  readonly params: Promise<{ readonly orgSlug: string }>;
}) {
  return (
    <section>
      <h1>Quotes</h1>
      <Protected
        permission={permissions.quotes.list}
        pending={<p aria-busy="true" />}
        fallback={<p>Only owners can see every quote.</p>}
      >
        <Suspense fallback={<p aria-busy="true" />}>
          <Quotes params={props.params} />
        </Suspense>
      </Protected>
    </section>
  );
}
