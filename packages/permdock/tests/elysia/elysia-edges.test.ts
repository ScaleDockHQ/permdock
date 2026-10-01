import { Elysia } from 'elysia';
import { describe, expect, it } from 'vitest';

import { createPermDock, type ElysiaContext } from '../../src/elysia/index.ts';
import {
  memberUser,
  otherPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

describe('permdock/elysia edge cases', () => {
  it('protects a collection route without a loader and decorates the context', async () => {
    const { protect } = createPermDock(policy, { subject: () => memberUser });
    const bodies: unknown[] = [{ title: 'x' }, 'raw text'];
    const results = [];
    for (const body of bodies) {
      const ctx = {
        request: new Request('http://localhost/posts', { method: 'POST' }),
        body,
      };
      const response = await protect(permissions.post.list)(ctx);
      // SAFETY: protect decorates ctx with permdock when it grants.
      const decorated = ctx as unknown as ElysiaContext;
      results.push({
        response,
        principal: decorated.permdock.subject.principal?.id,
        data: decorated.permdockData,
      });
    }
    const json = {
      request: new Request('http://localhost/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
      body: { title: 'y' },
    };
    expect(await protect(permissions.post.list)(json)).toBeUndefined();
    expect(results).toEqual([
      { response: undefined, principal: 'u1', data: undefined },
      { response: undefined, principal: 'u1', data: undefined },
    ]);
  });

  it('turns a thrown assert in a route into a problem response', async () => {
    const { permdock } = createPermDock(policy, { subject: () => memberUser });
    const app = new Elysia().use(permdock()).get('/posts/p2', (ctx) => {
      // SAFETY: the permdock() plugin derives ctx.permdock for every route.
      (ctx as unknown as ElysiaContext).permdock.assert(
        permissions.post.update,
        otherPost,
      );
      return { ok: true };
    });
    const response = await app.handle(new Request('http://localhost/posts/p2'));
    expect({
      status: response.status,
      type: response.headers.get('content-type'),
    }).toEqual({
      status: 403,
      type: expect.stringContaining('application/problem+json'),
    });
  });

  it('serves the snapshot on GET from the evaluations handler', async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new Elysia().group('/api/permdock', (group) =>
      group.use(permdockHandler()),
    );
    const response = await app.handle(
      new Request('http://localhost/api/permdock'),
    );
    expect(response.status).toBe(200);
  });
});
