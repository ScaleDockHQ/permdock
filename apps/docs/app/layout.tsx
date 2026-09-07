import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { RootProvider } from 'fumadocs-ui/provider/next';
import { Inter } from 'next/font/google';

import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: 'PermDock',
    template: '%s | PermDock',
  },
  description:
    'Typed permissions for TypeScript apps, APIs, databases, and AI agents.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
