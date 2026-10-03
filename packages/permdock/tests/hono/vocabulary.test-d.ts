import { Hono } from 'hono';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from '../fixtures/vocabulary.ts';

import { createPermDock } from '../../src/hono/index.ts';
import { permissions, policy } from '../fixtures/vocabulary.ts';

const { permdock, protect } = createPermDock(policy, { subject: () => null });

describe('permdock/hono vocabulary', () => {
  it('hands routes the instance typed by the policy vocabulary', () => {
    new Hono().use(permdock()).get('/', protect(permissions.post.read), (c) => {
      expectTypeOf(c.get('permdock')).toEqualTypeOf<VocabularyPermDock>();
      expectTypeOf(c.get('permdock').roles).toEqualTypeOf<typeof roles>();
      expectTypeOf(c.get('permdock')).toEqualTypeOf<
        PermDockOf<typeof policy>
      >();
      return c.body(null);
    });
  });
});
