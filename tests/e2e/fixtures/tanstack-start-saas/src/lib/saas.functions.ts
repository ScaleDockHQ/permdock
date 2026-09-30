import type { Snapshot } from 'permdock';
import type { SaasProject } from 'permdock/testing/saas';

import { createServerFn } from '@tanstack/react-start';
import {
  getRequestHeader,
  setResponseHeader,
} from '@tanstack/react-start/server';
import { saasPermissions as p } from 'permdock/testing/saas';

import {
  deleteProject,
  findOrg,
  projectsOf,
  readSession,
  saasPermDock,
  saasSnapshot,
} from '@permdock/e2e-saas-kit';

function session() {
  setResponseHeader('cache-control', 'private, no-store');
  return readSession(getRequestHeader('cookie'));
}

function orgInput(data: unknown): { org: string } {
  const org = (data as { org?: unknown } | null)?.org;
  return { org: typeof org === 'string' ? org : '' };
}

export type OrgView = { id: string; name: string; plan: string } | null;

export const getOrgView = createServerFn({ method: 'GET' })
  .validator(orgInput)
  .handler(async ({ data }): Promise<{ signedIn: boolean; org: OrgView }> => {
    const current = await session();
    const org = findOrg(data.org);
    return {
      signedIn: current !== null,
      org:
        org === undefined
          ? null
          : { id: org.id, name: org.name, plan: org.plan },
    };
  });

export const getSnapshot = createServerFn({ method: 'GET', strict: false })
  .validator(orgInput)
  .handler(async ({ data }): Promise<Snapshot> =>
    saasSnapshot(await session(), data.org),
  );

export const getProjects = createServerFn({ method: 'GET' })
  .validator(orgInput)
  .handler(
    async ({
      data,
    }): Promise<{ forbidden: boolean; projects: SaasProject[] }> => {
      const permdock = await saasPermDock(await session(), data.org);
      if (!permdock.can(p.project.list)) {
        return { forbidden: true, projects: [] };
      }
      return {
        forbidden: false,
        projects: permdock.filter(p.project.read, projectsOf(data.org)),
      };
    },
  );

export const removeProject = createServerFn({ method: 'POST' })
  .validator((data: unknown) => {
    const id = (data as { id?: unknown } | null)?.id;
    return { id: typeof id === 'string' ? id : '' };
  })
  .handler(async ({ data }) => deleteProject(await session(), data.id));
