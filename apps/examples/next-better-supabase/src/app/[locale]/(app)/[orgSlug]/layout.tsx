import Link from "next/link";
import { locale } from "next/root-params";
import { Suspense } from "react";

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";

import { snapshotForSlug } from "../../../../features/organization/organization-queries.ts";
import { PermDockProvider } from "../../../../permdock/server.ts";
import { Nav, NavSkeleton } from "./nav.tsx";

const organizations = [
  { slug: "acme", name: "Acme" },
  { slug: "globex", name: "Globex" },
] as const;

async function OrganizationSwitch() {
  const prefix: `/${string}` = `/${await locale()}`;
  return (
    <header>
      <nav aria-label="Organizations">
        {organizations.map((organization) => (
          <Link
            key={organization.slug}
            href={`${prefix}/${organization.slug}/staff`}
            prefetch
            className="text-sm"
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
export default function OrganizationLayout(
  props: LayoutProps<"/[locale]/[orgSlug]">,
) {
  const base = props.params.then(
    (params): `/${string}/${string}` => `/${params.locale}/${params.orgSlug}`,
  );
  const snapshot = props.params
    .then(({ orgSlug }) => orgSlug)
    .then(snapshotForSlug);
  return (
    <PermDockProvider snapshot={snapshot}>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <OrganizationSwitch />
          </SidebarHeader>
          <SidebarContent>
            <Suspense fallback={<NavSkeleton />}>
              <Nav base={base} />
            </Suspense>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          <main className="flex flex-col gap-4 p-4">{props.children}</main>
        </SidebarInset>
      </SidebarProvider>
    </PermDockProvider>
  );
}
