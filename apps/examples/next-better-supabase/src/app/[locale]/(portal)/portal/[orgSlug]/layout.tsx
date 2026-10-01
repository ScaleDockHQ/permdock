import type { ReactNode } from 'react';

import { PermDockProvider } from 'permdock/react';

import { snapshotForSlug } from '../../../../../lib/access.ts';

/** The customer portal: same snapshot loader, the contact's grants are customer-scoped. */
export default function PortalLayout(props: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly orgSlug: string }>;
}) {
  const snapshot = props.params
    .then(({ orgSlug }) => orgSlug)
    .then(snapshotForSlug);
  return (
    <PermDockProvider snapshotPromise={snapshot} endpoint={false}>
      <main>{props.children}</main>
    </PermDockProvider>
  );
}
