import { describe, expectTypeOf, it } from 'vitest';

import type { Decision } from '../../src/index.ts';

describe('type fixtures', () => {
  it('Decision.outcome is exhaustive', () => {
    // SAFETY: only the outcome union is under test; the other Decision fields are never read.
    const decision = { outcome: 'granted' } as Decision;
    switch (decision.outcome) {
      case 'granted':
      case 'denied':
      case 'approval-required':
        break;
      default: {
        const exhaustive: never = decision;
        expectTypeOf(exhaustive).toBeNever();
      }
    }
  });
});
