import type { Membership } from 'permdock';
import type { SaasOrg, SaasPlan, SaasProject } from 'permdock/testing/saas';

import { saasSeed } from 'permdock/testing/saas';

type MemberRow = {
  readonly user: string;
  readonly tenant: string;
  readonly team?: string;
  readonly on?: { readonly resource: string; readonly id: string };
  readonly expiresAt?: number;
  roles: string[];
};

type Store = {
  orgs: Map<string, SaasOrg>;
  members: MemberRow[];
  projects: SaasProject[];
  versions: Map<string, number>;
};

const ORG_IDS: ReadonlySet<string> = new Set(['acme', 'globex']);

function seed(): Store {
  return {
    orgs: new Map(
      saasSeed.orgs
        .filter((org) => ORG_IDS.has(org.id))
        .map((org) => [org.id, org]),
    ),
    members: saasSeed.members.flatMap((row) =>
      row.tenant !== undefined && ORG_IDS.has(row.tenant)
        ? [
            {
              user: row.user,
              tenant: row.tenant,
              roles: [...row.roles],
              ...(row.team === undefined ? {} : { team: row.team }),
              ...(row.on === undefined
                ? {}
                : { on: { resource: row.on.resource, id: row.on.id } }),
              ...(row.expiresAt === undefined
                ? {}
                : { expiresAt: row.expiresAt }),
            },
          ]
        : [],
    ),
    projects: saasSeed.projects.filter((project) => ORG_IDS.has(project.orgId)),
    versions: new Map(),
  };
}

const KEY = Symbol.for('permdock.e2e.saas-kit.store');

// One store per server process: frameworks may load this module more than once.
function store(): Store {
  const holder = globalThis as { [KEY]?: Store };
  holder[KEY] ??= seed();
  return holder[KEY];
}

function bump(key: string): void {
  store().versions.set(key, Date.now() / 1000);
}

export function resetStore(): void {
  (globalThis as { [KEY]?: Store })[KEY] = seed();
}

export function findOrg(id: string): SaasOrg | undefined {
  return store().orgs.get(id);
}

export function setPlan(id: string, plan: SaasPlan): boolean {
  const org = store().orgs.get(id);
  if (org === undefined) {
    return false;
  }
  store().orgs.set(id, { ...org, plan });
  bump(`org:${id}`);
  return true;
}

export function membershipsOf(user: string): Membership[] {
  return store()
    .members.filter((row) => row.user === user)
    .map((row) => ({
      tenant: row.tenant,
      roles: [...row.roles],
      ...(row.team === undefined ? {} : { team: row.team }),
      ...(row.on === undefined ? {} : { on: row.on }),
      ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
    }));
}

/** Sets the tenant-wide role; team and resource memberships are untouched. */
export function setRole(tenant: string, user: string, role: string): boolean {
  const row = store().members.find(
    (item) =>
      item.tenant === tenant &&
      item.user === user &&
      item.team === undefined &&
      item.on === undefined,
  );
  if (row === undefined) {
    return false;
  }
  row.roles = [role];
  bump(`user:${user}`);
  return true;
}

export function projectsOf(tenant: string): SaasProject[] {
  return store().projects.filter((project) => project.orgId === tenant);
}

export function findProject(id: string): SaasProject | undefined {
  return store().projects.find((project) => project.id === id);
}

export function removeProject(id: string): void {
  const state = store();
  const project = state.projects.find((item) => item.id === id);
  state.projects = state.projects.filter((item) => item.id !== id);
  if (project !== undefined) {
    bump(`org:${project.orgId}`);
  }
}

/** Epoch seconds of the latest change to any of `keys`; 0 when none changed. */
export function changedAt(keys: readonly string[]): number {
  const versions = store().versions;
  return Math.max(0, ...keys.map((key) => versions.get(key) ?? 0));
}
