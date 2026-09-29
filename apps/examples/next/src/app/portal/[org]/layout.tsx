import type { ReactNode } from 'react';

import Link from 'next/link';
import { PermDockProvider } from 'permdock/react';

import { loadSnapshot } from '../../../lib/access.ts';

export default function PortalLayout(props: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly org: string }>;
}) {
  const snapshot = props.params.then(({ org }) => org).then(loadSnapshot);
  return (
    <PermDockProvider snapshotPromise={snapshot}>
      <header>
        <p>Customer portal</p>
        <Link href="/">Switch account</Link>
      </header>
      <main>{props.children}</main>
    </PermDockProvider>
  );
}
