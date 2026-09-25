import type { CustomRole, Membership } from 'permdock';

import type { Project } from '../permissions.ts';

export type Plan = 'free' | 'pro';

export type Org = {
  readonly id: string;
  readonly name: string;
  readonly plan: Plan;
  readonly customRoles: readonly CustomRole[];
};

type MemberRow = {
  readonly user: string;
  readonly tenant: string;
  roles: string[];
};

type Store = {
  orgs: Map<string, Org>;
  members: MemberRow[];
  projects: Project[];
  versions: Map<string, number>;
};

function seed(): Store {
  return {
    orgs: new Map<string, Org>([
      [
        'acme',
        {
          id: 'acme',
          name: 'Acme',
          plan: 'free',
          customRoles: [
            { tenant: 'acme', name: 'contractor', includes: ['member'] },
          ],
        },
      ],
      [
        'globex',
        { id: 'globex', name: 'Globex', plan: 'pro', customRoles: [] },
      ],
    ]),
    members: [
      { user: 'alice', tenant: 'acme', roles: ['admin'] },
      { user: 'alice', tenant: 'globex', roles: ['viewer'] },
      { user: 'bob', tenant: 'acme', roles: ['member'] },
      { user: 'carol', tenant: 'acme', roles: ['owner'] },
      { user: 'dave', tenant: 'acme', roles: ['contractor'] },
    ],
    projects: [
      {
        id: 'p1',
        orgId: 'acme',
        ownerId: 'bob',
        name: 'Rocket',
        archived: false,
      },
      {
        id: 'p2',
        orgId: 'acme',
        ownerId: 'alice',
        name: 'Anvil',
        archived: false,
      },
      {
        id: 'p3',
        orgId: 'acme',
        ownerId: 'bob',
        name: 'Magnet',
        archived: false,
      },
      {
        id: 'p4',
        orgId: 'acme',
        ownerId: 'bob',
        name: 'Old tunnel',
        archived: true,
      },
      {
        id: 'g1',
        orgId: 'globex',
        ownerId: 'alice',
        name: 'Hammock',
        archived: false,
      },
    ],
    versions: new Map(),
  };
}

const KEY = Symbol.for('permdock.e2e.next-saas.store');

// One store per server process, shared by the proxy-free server bundles.
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

export function findOrg(id: string): Org | undefined {
  return store().orgs.get(id);
}

export function setPlan(id: string, plan: Plan): boolean {
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
    .map((row) => ({ tenant: row.tenant, roles: [...row.roles] }));
}

export function membersOf(tenant: string): { user: string; role: string }[] {
  return store()
    .members.filter((row) => row.tenant === tenant)
    .map((row) => ({ user: row.user, role: row.roles[0] ?? '' }));
}

export function setRole(tenant: string, user: string, role: string): boolean {
  const row = store().members.find(
    (item) => item.tenant === tenant && item.user === user,
  );
  if (row === undefined) {
    return false;
  }
  row.roles = [role];
  bump(`user:${user}`);
  return true;
}

export function projectsOf(tenant: string): Project[] {
  return store().projects.filter((project) => project.orgId === tenant);
}

export function findProject(id: string): Project | undefined {
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
