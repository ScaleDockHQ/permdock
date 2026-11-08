import { Suspense } from "react";

import { loadSnapshot } from "../../features/organization/organization-queries.ts";
import { clientBundle } from "../../permdock/bundle.ts";
import { PermDockProvider } from "../../permdock/server.ts";
import { Header } from "./header.tsx";
import { Nav, NavSkeleton } from "./nav.tsx";

// The build fails when a later change adds request-time rendering to the App Shell.
export const ensureStatic = "shell";

// Synchronous: the layout is static, and only the gated nav waits for the
// private-cached snapshot, which a prefetch already carries.
export default function OrganizationLayout(props: LayoutProps<"/[org]">) {
  const organization = props.params.then(({ org }) => org);
  const snapshot = organization.then(loadSnapshot);
  return (
    <PermDockProvider snapshot={snapshot} bundle={clientBundle}>
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
