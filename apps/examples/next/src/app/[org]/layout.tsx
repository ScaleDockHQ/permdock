import type { ReactNode } from "react";

import { PermDockProvider } from "permdock/react";
import { Suspense } from "react";

import { loadSnapshot } from "../../lib/access.ts";
import { Header } from "./header.tsx";
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
      <Header organization={organization} />
      <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 sm:px-6 md:grid-cols-[13rem_1fr] md:gap-10 md:py-10">
        <aside className="min-w-0 md:sticky md:top-24 md:self-start">
          <Suspense fallback={<NavSkeleton />}>
            <Nav organization={organization} />
          </Suspense>
        </aside>
        <main className="min-w-0">{props.children}</main>
      </div>
    </PermDockProvider>
  );
}
