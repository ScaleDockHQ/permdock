import type { ReactNode } from "react";

import Link from "next/link";
import { locale } from "next/root-params";
import { Suspense } from "react";

import { snapshotForSlug } from "../../../../lib/access.ts";
import { PermDockProvider } from "../../../../permdock/server.ts";
import { Nav, NavSkeleton } from "./nav.tsx";

const organizations = [
  { slug: "acme", name: "Acme" },
  { slug: "globex", name: "Globex" },
] as const;

async function OrganizationSwitch() {
  const prefix = `/${await locale()}`;
  return (
    <header>
      <nav aria-label="Organizations">
        {organizations.map((organization) => (
          <Link
            key={organization.slug}
            href={`${prefix}/${organization.slug}/staff`}
            prefetch
            data-switch={organization.slug}
          >
            {organization.name}
          </Link>
        ))}
      </nav>
    </header>
  );
}

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
    (params) => `/${params.locale}/${params.orgSlug}`,
  );
  const snapshot = props.params
    .then(({ orgSlug }) => orgSlug)
    .then(snapshotForSlug);
  return (
    <PermDockProvider snapshot={snapshot}>
      <OrganizationSwitch />
      <Suspense fallback={<NavSkeleton />}>
        <Nav base={base} />
      </Suspense>
      <main>{props.children}</main>
    </PermDockProvider>
  );
}
