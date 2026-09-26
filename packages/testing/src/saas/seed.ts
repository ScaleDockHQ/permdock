import type { CustomRole, Membership, Principal } from 'permdock';

import type { SaasDoc, SaasProject } from './permissions.ts';

export type SaasPlan = 'free' | 'pro';

export type SaasOrg = {
  readonly id: string;
  readonly name: string;
  readonly plan: SaasPlan;
  readonly customRoles: readonly CustomRole[];
};

export type SaasMember = {
  readonly user: string;
  /** Absent on a resource-scoped membership, which carries only `on`. */
  readonly tenant?: string;
  readonly team?: string;
  readonly on?: { readonly resource: string; readonly id: string };
  readonly roles: readonly string[];
  readonly expiresAt?: number;
};

export type SaasSeed = {
  readonly orgs: readonly SaasOrg[];
  readonly members: readonly SaasMember[];
  readonly projects: readonly SaasProject[];
  readonly docs: readonly SaasDoc[];
};

/** Epoch seconds in the past, so the membership is expired for any clock. */
export const SAAS_EXPIRED_AT = 1_000_000_000;

/**
 * Users, one hazard each:
 * - alice: admin in acme, viewer in globex (different role per org)
 * - bob: member in acme (owns p1, p3, p4)
 * - carol: owner in acme
 * - dave: custom `contractor` role in acme (includes member)
 * - erin: admin in acme AND globex (same role in two orgs)
 * - frank: expired acme membership
 * - mallory: no memberships at all
 * - gina: `lead` of team-a in acme
 * - hank: viewer in acme, `collaborator` on project p3 only
 * - `user-2` and `2`: members of `org-1`; `Date.parse` maps both ids to one instant
 * - tina: member of `tenant-1`; `Date.parse('org-1') === Date.parse('tenant-1')`
 */
export const saasSeed: SaasSeed = Object.freeze({
  orgs: [
    {
      id: 'acme',
      name: 'Acme',
      plan: 'free',
      customRoles: [
        { tenant: 'acme', name: 'contractor', includes: ['member'] },
      ],
    },
    { id: 'globex', name: 'Globex', plan: 'pro', customRoles: [] },
    { id: 'org-1', name: 'Org One', plan: 'pro', customRoles: [] },
    { id: 'tenant-1', name: 'Tenant One', plan: 'pro', customRoles: [] },
  ],
  members: [
    { user: 'alice', tenant: 'acme', roles: ['admin'] },
    { user: 'alice', tenant: 'globex', roles: ['viewer'] },
    { user: 'bob', tenant: 'acme', roles: ['member'] },
    { user: 'carol', tenant: 'acme', roles: ['owner'] },
    { user: 'dave', tenant: 'acme', roles: ['contractor'] },
    { user: 'erin', tenant: 'acme', roles: ['admin'] },
    { user: 'erin', tenant: 'globex', roles: ['admin'] },
    {
      user: 'frank',
      tenant: 'acme',
      roles: ['member'],
      expiresAt: SAAS_EXPIRED_AT,
    },
    { user: 'gina', tenant: 'acme', roles: ['viewer'] },
    { user: 'gina', tenant: 'acme', team: 'team-a', roles: ['lead'] },
    { user: 'hank', tenant: 'acme', roles: ['viewer'] },
    {
      user: 'hank',
      on: { resource: 'project', id: 'p3' },
      roles: ['collaborator'],
    },
    { user: 'user-2', tenant: 'org-1', roles: ['member'] },
    { user: '2', tenant: 'org-1', roles: ['member'] },
    { user: 'tina', tenant: 'tenant-1', roles: ['member'] },
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
    {
      id: 'n1',
      orgId: 'org-1',
      ownerId: 'user-2',
      name: 'Numbered',
      archived: false,
    },
    {
      id: 'o1',
      orgId: 'org-1',
      ownerId: 'tina',
      name: 'Lookalike',
      archived: false,
    },
  ],
  docs: [
    {
      id: 'd1',
      orgId: 'acme',
      teamId: 'team-a',
      title: 'Roadmap',
      locked: false,
    },
    {
      id: 'd2',
      orgId: 'acme',
      teamId: 'team-a',
      title: 'Signed contract',
      locked: true,
    },
    {
      id: 'd3',
      orgId: 'acme',
      teamId: 'team-b',
      title: 'Other team',
      locked: false,
    },
  ],
});

/** Every user id in the seed. */
export const saasUsers = [
  ...new Set(saasSeed.members.map((member) => member.user)),
  'mallory',
] as const;

export function saasOrg(id: string): SaasOrg | undefined {
  return saasSeed.orgs.find((org) => org.id === id);
}

function toMembership(member: SaasMember): Membership {
  const membership: {
    tenant?: string;
    team?: string;
    on?: { readonly resource: string; readonly id: string };
    roles: string[];
    expiresAt?: number;
  } = { roles: [...member.roles] };
  if (member.tenant !== undefined) {
    membership.tenant = member.tenant;
  }
  if (member.team !== undefined) {
    membership.team = member.team;
  }
  if (member.on !== undefined) {
    membership.on = { resource: member.on.resource, id: member.on.id };
  }
  if (member.expiresAt !== undefined) {
    membership.expiresAt = member.expiresAt;
  }
  return membership;
}

/** Memberships of `user` as the PermDock `Membership` shape. */
export function saasMemberships(
  user: string,
  members: readonly SaasMember[] = saasSeed.members,
): Membership[] {
  return members
    .filter((member) => member.user === user)
    .map((member) => toMembership(member));
}

/** Custom roles of every org, as `createPermDock({ customRoles })` expects. */
export const saasCustomRoles: readonly CustomRole[] = saasSeed.orgs.flatMap(
  (org) => org.customRoles,
);

/**
 * The principal for `user`, with the plans of the requested `tenant`'s org.
 * The tenant itself is passed to `createPermDock({ tenant })`, never trusted
 * from here.
 */
export function saasPrincipal(user: string, tenant?: string): Principal {
  const org = tenant === undefined ? undefined : saasOrg(tenant);
  return {
    id: user,
    memberships: saasMemberships(user),
    plans: org === undefined ? [] : [org.plan],
  };
}
