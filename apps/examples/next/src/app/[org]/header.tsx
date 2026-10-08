import { LogOut } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { Brand } from "@/components/brand.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";

import { Account, AccountSkeleton } from "./account.tsx";
import { OrgSwitcher } from "./org-switcher.tsx";
import { SnapshotStamp } from "./snapshot-stamp.tsx";

async function ActiveOrgSwitcher(props: {
  readonly organization: Promise<string>;
}) {
  return <OrgSwitcher active={await props.organization} />;
}

export function Header(props: { readonly organization: Promise<string> }) {
  const { organization } = props;
  return (
    <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <Brand label="Next.js example" />
        <Suspense fallback={<OrgSwitcher active={null} />}>
          <ActiveOrgSwitcher organization={organization} />
        </Suspense>
        <div className="ml-auto flex items-center gap-2">
          <SnapshotStamp />
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
  );
}
