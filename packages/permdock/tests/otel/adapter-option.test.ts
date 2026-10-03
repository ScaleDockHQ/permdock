import { Hono } from 'hono';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PermDock } from '../../src/core/permdock.ts';
import type { VocabularyPermDock } from '../fixtures/vocabulary.ts';

import { createPermDock } from '../../src/hono/index.ts';
import { withOtel } from '../../src/otel/instrument.ts';
import { permissions, policy } from '../fixtures/vocabulary.ts';

describe('the adapter otel option', () => {
  it('wraps every request-scoped instance and keeps the vocabulary', async () => {
    const wrapped: PermDock[] = [];
    const { permdock, protect } = createPermDock(policy, {
      subject: () => ({ id: 'u1' }),
      otel: (instance) => {
        wrapped.push(instance);
        return withOtel(instance, { tracer: 'test' });
      },
    });
    const app = new Hono()
      .use(permdock())
      .get('/', protect(permissions.post.read), (c) => {
        expectTypeOf(c.get('permdock')).toEqualTypeOf<VocabularyPermDock>();
        return c.body(null, 204);
      });
    expect((await app.request('/')).status).toBe(204);
    expect((await app.request('/')).status).toBe(204);
    expect(wrapped).toHaveLength(2);
  });
});
