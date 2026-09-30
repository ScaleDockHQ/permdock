import type { Metadata } from 'next';

import Link from 'next/link';

import { RootDocument, rootMetadata } from '@/components/root-document';
import { docsIndex } from '@/lib/shared';

import './global.css';

export const metadata: Metadata = {
  ...rootMetadata,
  title: 'Page not found',
};

export default function GlobalNotFound() {
  return (
    <RootDocument>
      <main className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-6 py-24 text-center">
        <h1 className="text-3xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          That URL is not a docs page.
        </p>
        <Link href={docsIndex} className="underline">
          Go to the docs
        </Link>
      </main>
    </RootDocument>
  );
}
