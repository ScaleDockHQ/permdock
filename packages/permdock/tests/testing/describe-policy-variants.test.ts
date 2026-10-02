import { describe } from 'vitest';

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from '../../src/index.ts';
import { describePolicy } from '../../src/testing/describe-policy.ts';

const permissions = definePermissions({
  doc: resource({
    id: 'id',
    actions: ['read', 'update'],
    collection: ['list'],
  }),
});

const policy = definePolicy(permissions, {
  roles: [
    role('viewer', [allow(permissions.doc.read), allow(permissions.doc.list)]),
  ],
  subject: (user: { readonly id: string } | null) =>
    user === null ? null : { id: user.id, roles: ['viewer'] },
});

describe('describePolicy without fixtures', () => {
  describePolicy(policy, {
    subjects: { vera: { id: 'vera' } },
    matrix: {
      [permissions.doc.read.key]: { vera: 'granted' },
      [permissions.doc.update.key]: {
        vera: {
          denials: [{ role: null, reason: 'no-grant' }],
          alternatives: [permissions.doc.read.key, permissions.doc.list.key],
        },
        ghost: { outcome: 'denied' },
      },
      [permissions.doc.list.key]: {
        vera: { outcome: 'granted', obligations: [] },
        ghost: 'denied',
      },
    },
  });
});

describe('describePolicy with nested rows', () => {
  describePolicy(policy, {
    subjects: { vera: { id: 'vera' } },
    fixtures: { doc: { id: 'd1' } },
    exhaustive: false,
    matrix: {
      [permissions.doc.read.key]: {
        doc: { vera: 'granted', ghost: 'denied' },
        stray: 'denied',
      },
    },
  });
});

/**
 * The attenuation invariants of security/delegation.mdx, one vector each,
 * exercised through a policy delegation and checked on the snapshot client too.
 */
const delegating = definePolicy(permissions, {
  roles: [
    role('viewer', [allow(permissions.doc.read), allow(permissions.doc.list)]),
    role('editor', [
      allow(permissions.doc.read),
      allow(permissions.doc.update, { where: { locked: false } }),
      deny(permissions.doc.update, { where: { id: 'frozen' }, name: 'freeze' }),
    ]),
  ],
  delegations: [
    { from: 'viewer', to: 'eve', permissions: [permissions.doc.read] },
    { from: 'editor', to: 'eve', permissions: [permissions.doc] },
  ],
  subject: (user: { readonly id: string; readonly roles: string[] } | null) =>
    user,
});

describe('describePolicy through a policy delegation', () => {
  describePolicy(delegating, {
    subjects: {
      vera: { id: 'vera', roles: ['viewer'] },
      ed: { id: 'ed', roles: ['editor'] },
    },
    fixtures: {
      open: { id: 'd1', locked: false },
      locked: { id: 'd2', locked: true },
      frozen: { id: 'frozen', locked: false },
    },
    options: { actor: { id: 'agent-1', kind: 'eve' } },
    snapshot: true,
    matrix: {
      // Agent ≤ user: a delegation never adds what the principal lacks.
      [permissions.doc.read.key]: {
        open: { vera: 'granted', ed: 'granted' },
      },
      // Outside the delegated set is not-delegated even though the user may.
      [permissions.doc.list.key]: {
        vera: { denials: [{ role: null, reason: 'not-delegated' }] },
        ed: { denials: [{ role: null, reason: 'no-grant' }] },
      },
      // Conditions intersect and a deny is not delegable away.
      [permissions.doc.update.key]: {
        open: { vera: 'denied', ed: 'granted' },
        locked: { ed: { denials: [{ reason: 'condition' }] } },
        frozen: { ed: { deniedBy: 'freeze' } },
      },
    },
  });
});
