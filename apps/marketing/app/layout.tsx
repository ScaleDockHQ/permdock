import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Geist_Mono, Inter } from 'next/font/google';

import { SiteChrome } from '@/components/site/chrome';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { site } from '@/lib/site';
import { cn } from '@/lib/utils';

import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
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
    type: 'website',
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        inter.variable,
        geistMono.variable,
        'font-sans antialiased',
      )}
    >
      <body className="flex min-h-svh flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>
            <SiteChrome>{children}</SiteChrome>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
