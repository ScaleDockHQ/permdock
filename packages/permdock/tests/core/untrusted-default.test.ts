import { describe, expect, it } from 'vitest';

import { createPermDock } from '../../src/index.ts';
import { reasonOf } from '../fixtures/decisions.ts';
import {
  adminUser,
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

describe('decision data is untrusted unless marked trusted', () => {
  it('validates a row passed without options', async () => {
    const permdock = await createPermDock(policy, adminUser);
    const decision = permdock.decide(permissions.post.publish, { id: 'p2' });
    expect(decision.outcome).toBe('denied');
    expect(reasonOf(decision)).toBe('validation');
  });

  it('skips validation for a row marked trusted', async () => {
    const permdock = await createPermDock(policy, adminUser);
    expect(
      permdock.decide(permissions.post.publish, { id: 'p2' }, { trusted: true })
        .outcome,
    ).toBe('granted');
  });

  it('grants a schema-valid row without options', async () => {
    const permdock = await createPermDock(policy, memberUser);
    expect(permdock.can(permissions.post.update, ownPost)).toBe(true);
  });

  it('does not validate an instance check without a row', async () => {
    const permdock = await createPermDock(policy, memberUser);
    expect(permdock.can(permissions.post.read, undefined)).toBe(true);
  });
});
