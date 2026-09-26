import type { ReactNode } from 'react';

import Link from 'next/link';
import { PermDockProvider } from 'permdock/react';
import { Suspense } from 'react';

import { getOrg, loadSnapshot } from '../../lib/access.ts';
import { orgs } from '../../nav.ts';
import { Nav, NavSkeleton } from './nav.tsx';
import { RefreshSignal } from './refresh-signal.tsx';

export default function OrgLayout(props: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly org: string }>;
}) {
  const snapshot = props.params.then(({ org }) => loadSnapshot(org));
  const org = props.params.then(({ org: id }) => getOrg(id));
  return (
    <PermDockProvider snapshotPromise={snapshot}>
      <header>
        <nav aria-label="Organizations">
          {orgs.map((item) => (
            <Link
              key={item.id}
              href={`/${item.id}`}
              prefetch
              data-switch={item.id}
            >
              {item.name}
            </Link>
          ))}
        </nav>
        <form method="post" action="/api/logout">
          <button type="submit">Sign out</button>
        </form>
      </header>
      <Suspense fallback={<NavSkeleton />}>
        <Nav org={org} />
      </Suspense>
      <Suspense fallback={null}>
        <RefreshSignal />
      </Suspense>
      <main>{props.children}</main>
    </PermDockProvider>
  );
}
