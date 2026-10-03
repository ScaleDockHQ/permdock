import { describe, expectTypeOf, it } from 'vitest';

import type { PermDockOf, VocabularyPermDock } from '../fixtures/vocabulary.ts';

import { createPermDock } from '../../src/claude-agent/index.ts';
import { policy } from '../fixtures/vocabulary.ts';

const { permdock } = createPermDock(policy, {
  subject: () => null,
  tools: {},
});

describe('permdock/claude-agent vocabulary', () => {
  it('resolves the instance typed by the policy vocabulary', () => {
    expectTypeOf(permdock).returns.resolves.toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(permdock).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
  });
});
