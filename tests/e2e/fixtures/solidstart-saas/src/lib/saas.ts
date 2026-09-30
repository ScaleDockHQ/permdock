import type { Snapshot } from 'permdock';
import type { SaasProject } from 'permdock/testing/saas';

import { query, redirect } from '@solidjs/router';
import { saasPermissions as p } from 'permdock/testing/saas';
import { getRequestEvent } from 'solid-js/web';

import {
  deleteProject,
  findOrg,
  projectsOf,
  readSession,
  saasPermDock,
  saasSnapshot,
} from '@permdock/e2e-saas-kit';

function session() {
  const event = getRequestEvent();
  event?.response.headers.set('cache-control', 'private, no-store');
  return readSession(event?.request.headers.get('cookie') ?? null);
}

export type OrgView = { id: string; name: string; plan: string } | null;

export const getOrgView = query(async (org: string): Promise<OrgView> => {
  'use server';
  if ((await session()) === null) {
    // Solid Router's redirect contract: server functions throw the response.
    // oxlint-disable-next-line typescript/only-throw-error
    throw redirect('/login');
  }
  const view = findOrg(org);
  return view === undefined
    ? null
    : { id: view.id, name: view.name, plan: view.plan };
}, 'org-view');

export const getSnapshot = query(async (org: string): Promise<Snapshot> => {
  'use server';
  return saasSnapshot(await session(), org);
}, 'snapshot');

export const getProjects = query(
  async (
    org: string,
  ): Promise<{ forbidden: boolean; projects: SaasProject[] }> => {
    'use server';
    const permdock = await saasPermDock(await session(), org);
    if (!permdock.can(p.project.list)) {
      return { forbidden: true, projects: [] };
    }
    return {
      forbidden: false,
      projects: permdock.filter(p.project.read, projectsOf(org)),
    };
  },
  'projects',
);

/** A plain server function, so a denial does not revalidate the row away. */
export async function removeProject(
  id: string,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  'use server';
  return deleteProject(await session(), id);
}
