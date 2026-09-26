import { findOrg, saasSnapshot } from '@permdock/e2e-saas-kit';
import { redirect } from '@sveltejs/kit';

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, params, depends }) => {
  depends('saas:permissions');
  if (locals.session === null) {
    redirect(303, '/login');
  }
  const org = findOrg(params.org);
  return {
    snapshot: saasSnapshot(locals.session, params.org),
    org:
      org === undefined ? null : { id: org.id, name: org.name, plan: org.plan },
  };
};
