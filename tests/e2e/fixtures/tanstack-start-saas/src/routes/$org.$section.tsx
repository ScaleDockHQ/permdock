import { createFileRoute } from '@tanstack/react-router';
import { Protected } from 'permdock/react';

import { navItemFor } from '@permdock/e2e-saas-kit/nav';

import { Forbidden } from '../lib/forbidden';

export const Route = createFileRoute('/$org/$section')({
  component: Section,
});

function Section() {
  const { section } = Route.useParams();
  const item = navItemFor(section);
  if (item === undefined) {
    return <h1>Not found</h1>;
  }
  return (
    <>
      <h1>{item.label}</h1>
      <Protected
        permission={item.permission}
        fallback={<Forbidden label={item.label} />}
      >
        <p data-testid="section-content">{item.label} content</p>
      </Protected>
    </>
  );
}
