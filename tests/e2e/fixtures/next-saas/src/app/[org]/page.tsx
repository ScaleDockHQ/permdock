import { Suspense } from 'react';

import { DeniedBanner, QuickLinks } from './overview.tsx';

export default function Overview() {
  return (
    <>
      <h1>Overview</h1>
      <Suspense fallback={null}>
        <DeniedBanner />
        <QuickLinks />
      </Suspense>
    </>
  );
}
