import { projectsOf, readSession, saasPermDock } from '@permdock/e2e-saas-kit';
import { saasPermissions as p } from 'permdock/testing/saas';

/** Rows are filtered on the server; the snapshot only drives buttons. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store');
  const query = getQuery(event);
  const org = typeof query.org === 'string' ? query.org : '';
  const session = await readSession(getRequestHeader(event, 'cookie'));
  const permdock = await saasPermDock(session, org);
  if (!permdock.can(p.project.list)) {
    return { forbidden: true, projects: [] };
  }
  return {
    forbidden: false,
    projects: permdock.filter(p.project.read, projectsOf(org)),
  };
});
