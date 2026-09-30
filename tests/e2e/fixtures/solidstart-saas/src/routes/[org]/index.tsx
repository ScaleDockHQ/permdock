import { Protected } from 'permdock/solid';

import { permissions } from '@permdock/e2e-saas-kit/nav';

import { Forbidden } from '../../lib/forbidden';

export default function Overview() {
  return (
    <>
      <h1>Overview</h1>
      <Protected permission={permissions.project.list} fallback={<Forbidden />}>
        <p data-testid="overview">Welcome back.</p>
      </Protected>
    </>
  );
}
