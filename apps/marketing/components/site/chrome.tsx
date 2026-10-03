import type { ReactNode } from "react";

import { Navbar } from "@/components/blocks/navbar-12/components/navbar";
import { SiteFooter } from "@/components/site/footer";

export function SiteChrome({ children }: { children: ReactNode }) {
  return (
    <>
      <Navbar />
      <main className="flex flex-1 flex-col">{children}</main>
      <SiteFooter />
    </>
  );
}
