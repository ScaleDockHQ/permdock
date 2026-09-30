import type { CustomRole, Membership } from 'permdock';
import type { SaasPlan } from 'permdock/testing/saas';

import { saasSeed } from 'permdock/testing/saas';

import type { Project } from '../permissions.ts';

export type Plan = SaasPlan;

export type Org = {
  readonly id: string;
  readonly name: string;
  readonly plan: Plan;
  readonly customRoles: readonly CustomRole[];
};

type MemberRow = {
  readonly user: string;
  readonly tenant: string;
  readonly expiresAt?: number;
  roles: string[];
};

type Store = {
  orgs: Map<string, Org>;
  members: MemberRow[];
  projects: Project[];
  versions: Map<string, number>;
};

const ORGS: ReadonlySet<string> = new Set(['acme', 'globex']);
const USERS: ReadonlySet<string> = new Set([
  'alice',
  'bob',
  'carol',
  'dave',
  'erin',
  'frank',
  'mallory',
]);

// The shared SaaS seed, narrowed to what this app's spec numbers rely on.
function seed(): Store {
  return {
    orgs: new Map(
      saasSeed.orgs
        .filter((org) => ORGS.has(org.id))
        .map((org) => [org.id, org]),
    ),
    members: saasSeed.members.flatMap((row) =>
      row.tenant !== undefined &&
      ORGS.has(row.tenant) &&
      USERS.has(row.user) &&
      row.team === undefined &&
      row.on === undefined
        ? [
            {
              user: row.user,
              tenant: row.tenant,
              roles: [...row.roles],
              ...(row.expiresAt === undefined
                ? {}
                : { expiresAt: row.expiresAt }),
            },
          ]
        : [],
    ),
    projects: saasSeed.projects.filter((project) => ORGS.has(project.orgId)),
    versions: new Map(),
  };
}

const KEY = Symbol.for('permdock.e2e.next-saas.store');

// One store per server process, shared by the proxy-free server bundles.
function store(): Store {
  // SAFETY: KEY is a private Symbol.for key; only store() and resetStore() write it, with a Store
  const holder = globalThis as { [KEY]?: Store };
  holder[KEY] ??= seed();
  return holder[KEY];
}

function bump(key: string): void {
  store().versions.set(key, Date.now() / 1000);
}

export function resetStore(): void {
  // SAFETY: KEY is a private Symbol.for key; only store() and resetStore() write it, with a Store
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
    .map((row) => ({
      tenant: row.tenant,
      roles: [...row.roles],
      ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
    }));
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
