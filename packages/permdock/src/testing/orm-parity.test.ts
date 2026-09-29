import { describe, expect, it } from 'vitest';

import {
  allow,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from '../index.ts';
import { ormParity } from './orm-parity.ts';

const permissions = definePermissions({
  post: resource({ actions: ['read', 'review'] }),
});

type User = { readonly id: string };

const policy = definePolicy(permissions, {
  subject: (user: User) => ({ id: user.id, roles: ['member'] }),
  roles: [
    role('member', [
      allow(permissions.post.read, { where: { authorId: principal.id } }),
      allow(permissions.post.review, () => true),
    ]),
  ],
});

const rows = [
  { id: 'p1', authorId: 'u1' },
  { id: 'p2', authorId: 'u2' },
];

const read = {
  name: 'read',
  user: { id: 'u1' },
  permission: permissions.post.read,
  rows,
};
const review = {
  name: 'review',
  user: { id: 'u1' },
  permission: permissions.post.review,
  rows,
};

describe('ormParity', () => {
  it('passes when the database returns exactly the in-memory rows', async () => {
    const report = await ormParity(policy, [read], {
      run: async () => ['p1'],
    });
    expect(report.ok).toBe(true);
    expect(report.results[0]).toMatchObject({
      expected: ['p1'],
      actual: ['p1'],
      partial: false,
    });
  });

  it('fails on extra or missing rows and on a thrown full where', async () => {
    const extra = await ormParity(policy, [read], {
      run: async () => ['p1', 'p2'],
    });
    expect(extra.ok).toBe(false);
    const thrown = await ormParity(policy, [read], {
      run: async () => {
        throw new Error('boom');
      },
    });
    expect(thrown.ok).toBe(false);
    expect(thrown.results[0]?.error).toBe('boom');
    const rejected = await ormParity(policy, [read], {
      // oxlint-disable-next-line prefer-promise-reject-errors, typescript/prefer-promise-reject-errors -- the runner must report a non-Error rejection
      run: () => Promise.reject('plain'),
    });
    expect(rejected.results[0]?.error).toBe('plain');
  });

  it('lets a partial where refuse or return a subset, never more', async () => {
    const refused = await ormParity(policy, [review], {
      run: async () => {
        throw new Error('non-portable');
      },
    });
    expect(refused.ok).toBe(true);
    expect(refused.results[0]?.partial).toBe(true);
    const subset = await ormParity(policy, [review], {
      run: async () => ['p2'],
    });
    expect(subset.ok).toBe(true);
    const superset = await ormParity(policy, [review], {
      run: async () => ['p1', 'p3'],
      id: 'id',
    });
    expect(superset.ok).toBe(false);
  });
});
