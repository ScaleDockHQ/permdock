'use client';

import { useParams } from 'next/navigation';
import { Protected } from 'permdock/react';

import { navItemFor } from '../../../nav.ts';
import { ForbiddenState } from '../forbidden-state.tsx';

export function Section() {
  const { section } = useParams<{ section: string }>();
  const item = navItemFor(section);
  if (item === undefined) {
    return <h1>Not found</h1>;
  }
  return (
    <>
      <h1>{item.label}</h1>
      <Protected
        permission={item.permission}
        pending={<p data-testid="gate-pending">Checking access…</p>}
        fallback={<ForbiddenState label={item.label} />}
      >
        <p data-testid="section-content">{item.label} content</p>
      </Protected>
    </>
  );
}
