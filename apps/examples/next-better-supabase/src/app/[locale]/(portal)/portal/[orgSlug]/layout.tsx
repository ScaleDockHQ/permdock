import type { ReactNode } from "react";

import { snapshotForSlug } from "../../../../../lib/access.ts";
import { PermDockProvider } from "../../../../../permdock/server.ts";

/**
 * The customer portal: same snapshot loader, the contact's grants are
 * customer-scoped.
 */
export default function PortalLayout(props: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly orgSlug: string }>;
}) {
  const snapshot = props.params
    .then(({ orgSlug }) => orgSlug)
    .then(snapshotForSlug);
  return (
    <PermDockProvider snapshot={snapshot}>
      <main>{props.children}</main>
    </PermDockProvider>
  );
}
