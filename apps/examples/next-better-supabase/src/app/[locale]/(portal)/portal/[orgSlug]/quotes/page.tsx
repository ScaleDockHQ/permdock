import { Protected } from "permdock/react";
import { Suspense } from "react";

import { permissions } from "../../../../../../policy.ts";
import { Quotes } from "../../../../quotes.tsx";

export const instant = true;

export default function PortalQuotes(props: {
  readonly params: Promise<{ readonly orgSlug: string }>;
}) {
  return (
    <section>
      <h1>Your quotes</h1>
      <Protected
        permission={permissions.quotes.list}
        pending={<p aria-busy="true" />}
        fallback={<p>Sign in as a customer contact to see quotes.</p>}
      >
        <Suspense fallback={<p aria-busy="true" />}>
          <Quotes params={props.params} />
        </Suspense>
      </Protected>
    </section>
  );
}
