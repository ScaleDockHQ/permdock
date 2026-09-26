import { projectsOf, saasPermDock } from '@permdock/e2e-saas-kit';
import { permissions } from '@permdock/e2e-saas-kit/nav';

import type { PageServerLoad } from './$types';

/** The rows are filtered on the server; the snapshot only drives buttons. */
export const load: PageServerLoad = async ({ locals, params, depends }) => {
  depends('saas:permissions');
  const permdock = await saasPermDock(locals.session, params.org);
  if (!permdock.can(permissions.project.list)) {
    return { forbidden: true, projects: [] };
  }
  return {
    forbidden: false,
    projects: permdock.filter(permissions.project.read, projectsOf(params.org)),
  };
};
