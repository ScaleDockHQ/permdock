import type { ReactNode } from "react";

import Link from "next/link";
import { PermDockProvider } from "permdock/react";
import { Suspense } from "react";

import { loadSnapshot } from "../../lib/access.ts";
import { organizations } from "../../lib/store.ts";
import { Nav, NavSkeleton } from "./nav.tsx";

// Synchronous: the layout is static, and only the gated nav waits for the
// private-cached snapshot, which a prefetch already carries.
export default function OrganizationLayout(props: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly org: string }>;
}) {
  const organization = props.params.then(({ org }) => org);
  const snapshot = organization.then(loadSnapshot);
  return (
    <PermDockProvider snapshotPromise={snapshot}>
      <header>
        <nav aria-label="Organizations">
          {organizations.map((item) => (
            <Link
              key={item.id}
              href={`/${item.id}`}
              prefetch
              data-switch={item.id}
            >
              {item.name}
            </Link>
          ))}
          <Link href="/">Switch account</Link>
        </nav>
      </header>
      <Suspense fallback={<NavSkeleton />}>
        <Nav organization={organization} />
      </Suspense>
      <main>{props.children}</main>
    </PermDockProvider>
  );
}
