import type { Permission } from 'permdock';

import type { SaasDoc, SaasProject } from './permissions.ts';

import { saasPermissions as p } from './permissions.ts';
import { saasSeed } from './seed.ts';

export type SaasOutcome = 'granted' | 'denied' | 'approval-required';

export type SaasScenario = {
  readonly name: string;
  readonly user: string;
  /** The requested tenant, as a route or header would pass it. */
  readonly tenant?: string;
  readonly permission: Permission;
  readonly row?: SaasProject | SaasDoc;
  readonly expected: {
    readonly outcome: SaasOutcome;
    /** One reason that must appear among the denials. */
    readonly reason?: string;
  };
  /**
   * `false` when the outcome depends on server-only inputs (a quota store,
   * approvals), so a snapshot client is not expected to match.
   */
  readonly client?: boolean;
  /**
   * The client outcome when it is stricter than the server's: a snapshot
   * cannot evaluate a closure deny, so it fails closed.
   */
  readonly clientOutcome?: SaasOutcome;
};

export function saasProject(id: string): SaasProject {
  const row = saasSeed.projects.find((project) => project.id === id);
  if (row === undefined) {
    throw new Error(`unknown fixture project ${id}`);
  }
  return row;
}

export function saasDoc(id: string): SaasDoc {
  const row = saasSeed.docs.find((doc) => doc.id === id);
  if (row === undefined) {
    throw new Error(`unknown fixture doc ${id}`);
  }
  return row;
}

/**
 * Hand-written expectations. Never derive `expected` from the engine: the
 * list is the oracle every adapter, ORM and client suite runs against.
 */
export const saasScenarios: readonly SaasScenario[] = Object.freeze([
  {
    name: 'admin updates any project in their org',
    user: 'alice',
    tenant: 'acme',
    permission: p.project.update,
    row: saasProject('p1'),
    expected: { outcome: 'granted' },
  },
  {
    name: 'viewer in the second org cannot update there',
    user: 'alice',
    tenant: 'globex',
    permission: p.project.update,
    row: saasProject('g1'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'viewer in the second org reads there',
    user: 'alice',
    tenant: 'globex',
    permission: p.project.read,
    row: saasProject('g1'),
    expected: { outcome: 'granted' },
  },
  {
    name: 'admin in acme cannot read a globex row while acting in acme',
    user: 'alice',
    tenant: 'acme',
    permission: p.project.read,
    row: saasProject('g1'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'member updates their own project',
    user: 'bob',
    tenant: 'acme',
    permission: p.project.update,
    row: saasProject('p1'),
    expected: { outcome: 'granted' },
  },
  {
    name: 'member cannot update a colleague project',
    user: 'bob',
    tenant: 'acme',
    permission: p.project.update,
    row: saasProject('p2'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'archived project cannot be deleted by its owner',
    user: 'bob',
    tenant: 'acme',
    permission: p.project.delete,
    row: saasProject('p4'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'archived project cannot be deleted by the org owner',
    user: 'carol',
    tenant: 'acme',
    permission: p.project.delete,
    row: saasProject('p4'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'owner manages billing',
    user: 'carol',
    tenant: 'acme',
    permission: p.billing.manage,
    expected: { outcome: 'granted' },
  },
  {
    name: 'admin cannot read billing',
    user: 'alice',
    tenant: 'acme',
    permission: p.billing.read,
    expected: { outcome: 'denied' },
  },
  {
    name: 'free plan hides analytics from admins',
    user: 'alice',
    tenant: 'acme',
    permission: p.analytics.read,
    expected: { outcome: 'denied' },
  },
  {
    name: 'pro plan shows analytics to admins',
    user: 'erin',
    tenant: 'globex',
    permission: p.analytics.read,
    expected: { outcome: 'granted' },
  },
  {
    name: 'same admin, free org: no analytics',
    user: 'erin',
    tenant: 'acme',
    permission: p.analytics.read,
    expected: { outcome: 'denied' },
  },
  {
    name: 'custom contractor role inherits member create',
    user: 'dave',
    tenant: 'acme',
    permission: p.project.create,
    expected: { outcome: 'granted' },
  },
  {
    name: 'custom contractor role cannot update a project it does not own',
    user: 'dave',
    tenant: 'acme',
    permission: p.project.update,
    row: saasProject('p1'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'expired membership reads nothing',
    user: 'frank',
    tenant: 'acme',
    permission: p.project.read,
    row: saasProject('p1'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'user without memberships reads nothing',
    user: 'mallory',
    tenant: 'acme',
    permission: p.project.read,
    row: saasProject('p1'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'user without memberships and no tenant lists nothing',
    user: 'mallory',
    permission: p.project.list,
    expected: { outcome: 'denied' },
  },
  {
    name: 'owner id user-2 updates its own row',
    user: 'user-2',
    tenant: 'org-1',
    permission: p.project.update,
    row: saasProject('n1'),
    expected: { outcome: 'granted' },
  },
  {
    name: 'id 2 is not id user-2',
    user: '2',
    tenant: 'org-1',
    permission: p.project.update,
    row: saasProject('n1'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'tenant-1 member cannot read an org-1 row',
    user: 'tina',
    tenant: 'tenant-1',
    permission: p.project.read,
    row: saasProject('o1'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'team lead updates a team doc',
    user: 'gina',
    tenant: 'acme',
    permission: p.doc.update,
    row: saasDoc('d1'),
    expected: { outcome: 'granted' },
    clientOutcome: 'denied',
  },
  {
    name: 'team lead cannot update a locked doc',
    user: 'gina',
    tenant: 'acme',
    permission: p.doc.update,
    row: saasDoc('d2'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'team lead cannot update another team doc',
    user: 'gina',
    tenant: 'acme',
    permission: p.doc.update,
    row: saasDoc('d3'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'viewer reads any doc in the org',
    user: 'gina',
    tenant: 'acme',
    permission: p.doc.read,
    row: saasDoc('d3'),
    expected: { outcome: 'granted' },
  },
  {
    name: 'project collaborator updates that project',
    user: 'hank',
    tenant: 'acme',
    permission: p.project.update,
    row: saasProject('p3'),
    expected: { outcome: 'granted' },
  },
  {
    name: 'project collaborator cannot update another project',
    user: 'hank',
    tenant: 'acme',
    permission: p.project.update,
    row: saasProject('p1'),
    expected: { outcome: 'denied' },
  },
  {
    name: 'admin revoking every key needs an owner approval',
    user: 'alice',
    tenant: 'acme',
    permission: p.apiKey.revokeAll,
    expected: { outcome: 'approval-required' },
    client: false,
  },
  {
    name: 'owner revokes every key directly',
    user: 'carol',
    tenant: 'acme',
    permission: p.apiKey.revokeAll,
    expected: { outcome: 'granted' },
  },
  {
    name: 'member cannot revoke keys',
    user: 'bob',
    tenant: 'acme',
    permission: p.apiKey.revokeAll,
    expected: { outcome: 'denied' },
  },
  {
    name: 'admin creates an api key within the quota',
    user: 'alice',
    tenant: 'acme',
    permission: p.apiKey.create,
    expected: { outcome: 'granted' },
    client: false,
  },
  {
    name: 'member cannot list members',
    user: 'bob',
    tenant: 'acme',
    permission: p.member.list,
    expected: { outcome: 'denied' },
  },
  {
    name: 'admin of the second org lists its members',
    user: 'erin',
    tenant: 'globex',
    permission: p.member.list,
    expected: { outcome: 'granted' },
  },
]);
