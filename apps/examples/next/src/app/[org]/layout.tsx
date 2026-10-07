import type { ReactNode } from "react";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { PermDockProvider } from "permdock/react";
import { Suspense } from "react";

import { Brand } from "@/components/brand.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";

import { loadSnapshot } from "../../lib/access.ts";
import { Account, AccountSkeleton } from "./account.tsx";
import { Nav, NavSkeleton } from "./nav.tsx";
import { OrgSwitcher } from "./org-switcher.tsx";

async function ActiveOrgSwitcher(props: {
  readonly organization: Promise<string>;
}) {
  return <OrgSwitcher active={await props.organization} />;
}

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
      <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <Brand label="Next.js example" />
          <Suspense fallback={<OrgSwitcher active={null} />}>
            <ActiveOrgSwitcher organization={organization} />
          </Suspense>
          <div className="ml-auto flex items-center gap-2">
            <Suspense fallback={<AccountSkeleton />}>
              <Account />
            </Suspense>
            <Link
              href="/"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              <LogOut data-icon="inline-start" />
              Switch account
            </Link>
          </div>
        </div>
      </header>
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
