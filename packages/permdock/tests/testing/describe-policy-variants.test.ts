import { describe } from 'vitest';

import {
  allow,
  definePermissions,
  definePolicy,
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
