import type { ReactNode } from "react";

import { Navbar } from "@/components/blocks/navbar-12/components/navbar";
import { SiteFooter } from "@/components/site/footer";

export function SiteChrome({ children }: { children: ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-3 focus:ring-ring/50"
      >
        Skip to content
      </a>
      <Navbar />
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col outline-none"
      >
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
