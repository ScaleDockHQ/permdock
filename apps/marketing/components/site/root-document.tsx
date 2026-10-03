import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Geist_Mono, Inter } from "next/font/google";

import { SiteChrome } from "@/components/site/chrome";
import { ThemeProvider } from "@/components/theme-provider";
import { site } from "@/lib/site";
import { TooltipProvider } from "@permdock/ui/components/tooltip";
import { cn } from "@permdock/ui/lib/utils";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const rootMetadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: site.name,
    template: `%s | ${site.name}`,
  },
  description: site.tagline,
  openGraph: {
    title: site.name,
    description: site.tagline,
    siteName: site.name,
    type: "website",
  },
};

export function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        inter.variable,
        geistMono.variable,
        "font-sans antialiased",
      )}
    >
      <body className="flex min-h-svh flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>
            <SiteChrome>{children}</SiteChrome>
          </TooltipProvider>
        </ThemeProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
