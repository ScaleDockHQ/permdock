import { describe, expectTypeOf, it } from 'vitest';

import type { PdpPermDock } from '../../src/pdp/index.ts';
import type { PolicyVocabularyOf, roles } from '../fixtures/vocabulary.ts';

import { createPermDock } from '../../src/pdp/index.ts';
import { policy } from '../fixtures/vocabulary.ts';

describe('permdock/pdp vocabulary', () => {
  it('returns the instance typed by the policy vocabulary', () => {
    const permdock = createPermDock(policy, null);
    expectTypeOf(permdock).resolves.toEqualTypeOf<
      PdpPermDock<PolicyVocabularyOf<typeof policy>>
    >();
    expectTypeOf(permdock)
      .resolves.toHaveProperty('roles')
      .toEqualTypeOf<typeof roles>();
  });
});
