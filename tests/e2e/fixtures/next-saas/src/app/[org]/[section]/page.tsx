import { Suspense } from 'react';

import { Section } from './section.tsx';

export default function SectionPage() {
  return (
    <Suspense fallback={<p data-testid="section-loading">Loading…</p>}>
      <Section />
    </Suspense>
  );
}
