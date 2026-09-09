import { describe, expect, it } from 'vitest';

import { DEMO_ACTIONS, demoDecide } from './devtools-demo';

describe('demoDecide', () => {
  it('grants member read and denies member delete', () => {
    expect(demoDecide('member', 'read').outcome).toBe('granted');
    expect(demoDecide('member', 'delete').outcome).toBe('denied');
  });

  it('asks for approval on admin publish', () => {
    expect(demoDecide('admin', 'publish').outcome).toBe('approval-required');
  });

  it('covers every demo action for admin without throwing', () => {
    for (const action of DEMO_ACTIONS) {
      expect(demoDecide('admin', action).permission.length).toBeGreaterThan(0);
    }
  });
});
