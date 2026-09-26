import { projectsOf } from '@permdock/e2e-saas-kit';
import { saasPermissions as p } from '@permdock/testing/saas/permissions';

import { noStore, orgOf, server } from '../../lib/server';

export async function GET(request: Request): Promise<Response> {
  const permdock = await server.permdock(request);
  if (!permdock.can(p.project.list)) {
    return Response.json(
      { forbidden: true, projects: [] },
      { headers: noStore },
    );
  }
  return Response.json(
    {
      forbidden: false,
      projects: permdock.filter(p.project.read, projectsOf(orgOf(request))),
    },
    { headers: noStore },
  );
}
