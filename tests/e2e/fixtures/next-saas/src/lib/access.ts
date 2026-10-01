import type { Membership, PermDock, Snapshot } from 'permdock';

import { cacheLife, cacheTag } from 'next/cache';
import { createPermDock, memoryRoleSource, snapshotFor } from 'permdock';
import { cacheLifeFor, snapshotTag } from 'permdock/next';

import type { Project } from '../permissions.ts';
import type { SessionClaims } from '../policy.ts';
import type { Org } from './store.ts';

import { policy, subjectOf } from '../policy.ts';
import { getClaims, membershipsFor } from './session.ts';
import { findOrg, membersOf, projectsOf } from './store.ts';

function membershipOption(claims: SessionClaims | null): {
  readonly memberships?: readonly Membership[];
} {
  const memberships = claims === null ? undefined : membershipsFor(claims);
  return memberships === undefined ? {} : { memberships };
}

export type OrgView = Pick<Org, 'id' | 'name' | 'plan' | 'customRoles'>;

/** Shared layer: per-org data every member sees, invalidated by `org:<id>`. */
export async function getOrg(id: string): Promise<OrgView | null> {
  'use cache';
  cacheTag(`org:${id}`);
  cacheLife('hours');
  const org = findOrg(id);
  return org === undefined
    ? null
    : {
        id: org.id,
        name: org.name,
        plan: org.plan,
        customRoles: org.customRoles,
      };
}

export async function getProjects(org: string): Promise<Project[]> {
  'use cache';
  cacheTag(`org:${org}`);
  cacheLife('hours');
  return projectsOf(org);
}

export async function getMembers(
  org: string,
): Promise<{ user: string; role: string }[]> {
  'use cache';
  cacheTag(`org:${org}`, 'members');
  cacheLife('hours');
  return membersOf(org);
}

async function buildSnapshot(org: string): Promise<{
  readonly snapshot: Snapshot;
  readonly user: string;
}> {
  const claims = await getClaims();
  const view = await getOrg(org);
  const snapshot = snapshotFor(policy, subjectOf(claims), {
    tenant: org,
    ...membershipOption(claims),
    customRoles: view?.customRoles ?? [],
    plans: view === null ? [] : [view.plan],
  });
  return { snapshot, user: claims?.sub ?? 'anon' };
}

/** Private layer: per session, prefetchable into the App Shell. */
async function loadSnapshotPrivate(org: string): Promise<Snapshot> {
  'use cache: private';
  const { snapshot, user } = await buildSnapshot(org);
  cacheLife(cacheLifeFor(snapshot));
  cacheTag(snapshotTag(user), `org:${org}`);
  return snapshot;
}

async function loadSnapshotUncached(org: string): Promise<Snapshot> {
  const { snapshot } = await buildSnapshot(org);
  return snapshot;
}

export const loadSnapshot: (org: string) => Promise<Snapshot> =
  process.env['PERMDOCK_E2E_NO_PRIVATE_CACHE'] === '1'
    ? loadSnapshotUncached
    : loadSnapshotPrivate;

/** Enforcement layer for Server Actions: never cached, reads the store in database mode. */
export async function serverPermDock(org: string): Promise<{
  readonly permdock: PermDock;
  readonly user: string | null;
}> {
  const claims = await getClaims();
  const view = findOrg(org);
  const subject = subjectOf(claims, {
    ...membershipOption(claims),
    plans: view === undefined ? [] : [view.plan],
  });
  const permdock = await createPermDock(policy, subject, {
    tenant: org,
    customRoles: memoryRoleSource(view?.customRoles ?? []),
  });
  return { permdock, user: claims?.sub ?? null };
}
