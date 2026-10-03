import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { Inter } from "next/font/google";

import { env } from "@/env";

const inter = Inter({
  subsets: ["latin"],
});

export const rootMetadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: {
    default: "PermDock",
    template: "%s | PermDock",
  },
  description:
    "Typed permissions for TypeScript apps, APIs, databases, and AI agents.",
};

export function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
