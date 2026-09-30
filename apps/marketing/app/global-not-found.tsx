import type { Metadata } from 'next';

import { NotFoundContent } from '@/components/site/not-found-content';
import { RootDocument, rootMetadata } from '@/components/site/root-document';

import './globals.css';

export const metadata: Metadata = {
  ...rootMetadata,
  title: 'Page not found',
};

export default function GlobalNotFound() {
  return (
    <RootDocument>
      <NotFoundContent />
    </RootDocument>
  );
}
