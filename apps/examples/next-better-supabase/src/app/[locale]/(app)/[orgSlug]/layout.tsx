import type { ReactNode } from "react";

import Link from "next/link";
import { Suspense } from "react";

import { snapshotForSlug } from "../../../../lib/access.ts";
import { PermDockProvider } from "../../../../permdock/server.ts";
import { Nav, NavSkeleton } from "./nav.tsx";

const organizations = [
  { slug: "acme", name: "Acme" },
  { slug: "globex", name: "Globex" },
] as const;

// Synchronous: the shell is static, and only the gated nav waits for the
// private-cached snapshot, which the prefetch already carries.
export default function OrganizationLayout(props: {
  readonly children: ReactNode;
  readonly params: Promise<{
    readonly locale: string;
    readonly orgSlug: string;
  }>;
}) {
  const base = props.params.then(
    ({ locale, orgSlug }) => `/${locale}/${orgSlug}`,
  );
  const snapshot = props.params
    .then(({ orgSlug }) => orgSlug)
    .then(snapshotForSlug);
  return (
    <PermDockProvider snapshot={snapshot}>
      <header>
        <nav aria-label="Organizations">
          {organizations.map((organization) => (
            <Link
              key={organization.slug}
              href={`/en/${organization.slug}/staff`}
              prefetch
              data-switch={organization.slug}
            >
              {organization.name}
            </Link>
          ))}
        </nav>
      </header>
      <Suspense fallback={<NavSkeleton />}>
        <Nav base={base} />
      </Suspense>
      <main>{props.children}</main>
    </PermDockProvider>
  );
}
