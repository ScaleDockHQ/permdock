import { describe, expectTypeOf, it } from 'vitest';

import type { PermDockOf, VocabularyPermDock } from '../fixtures/vocabulary.ts';

import { createPermDock } from '../../src/node/index.ts';
import { policy } from '../fixtures/vocabulary.ts';

const { permdock } = createPermDock(policy, { subject: () => null });

describe('permdock/node vocabulary', () => {
  it('resolves the instance typed by the policy vocabulary', () => {
    expectTypeOf(permdock).returns.resolves.toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(permdock).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
  });
});
