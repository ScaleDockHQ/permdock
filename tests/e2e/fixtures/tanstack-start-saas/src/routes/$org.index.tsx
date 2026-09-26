import { permissions } from '@permdock/e2e-saas-kit/nav';
import { createFileRoute } from '@tanstack/react-router';
import { Protected } from 'permdock/react';

import { Forbidden } from '../lib/forbidden';

export const Route = createFileRoute('/$org/')({
  component: () => (
    <>
      <h1>Overview</h1>
      <Protected permission={permissions.project.list} fallback={<Forbidden />}>
        <p data-testid="overview">Welcome back.</p>
      </Protected>
    </>
  ),
});
