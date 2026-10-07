import type { ReactNode } from "react";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { PermDockProvider } from "permdock/react";

import { Brand } from "@/components/brand.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";

import { loadSnapshot } from "../../../lib/access.ts";

export default function PortalLayout(props: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly org: string }>;
}) {
  const snapshot = props.params.then(({ org }) => org).then(loadSnapshot);
  return (
    <PermDockProvider snapshotPromise={snapshot}>
      <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 py-3 sm:px-6">
          <Brand label="Next.js example" />
          <Badge variant="outline">Customer portal</Badge>
          <Link
            href="/"
            className={buttonVariants({
              variant: "ghost",
              size: "sm",
              className: "ml-auto",
            })}
          >
            <LogOut data-icon="inline-start" />
            <span className="hidden sm:inline">Switch account</span>
            <span className="sr-only sm:hidden">Switch account</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 md:py-10">
        {props.children}
      </main>
    </PermDockProvider>
  );
}
