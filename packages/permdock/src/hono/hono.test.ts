import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

describe('permdock/hono', () => {
  it('sets a request-scoped instance and protects routes', async () => {
    const { permdock, protect } = createPermDock(policy, {
      subject: (c) => c.get('user'),
    });
    const app = new Hono();
    app.use(async (c, next) => {
      c.set('user', memberUser);
      await next();
    });
    app.use(permdock());
    app.delete(
      '/posts/:id',
      protect(permissions.post.update, (c) =>
        c.req.param('id') === 'p1' ? ownPost : otherPost,
      ),
      (c) => c.json({ ok: true, via: c.get('permdock').subject.principal?.id }),
    );

    const allowed = await app.request('http://localhost/posts/p1', {
      method: 'DELETE',
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, via: 'u1' });

    const denied = await app.request('http://localhost/posts/p2', {
      method: 'DELETE',
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('content-type')).toContain(
      'application/problem+json',
    );
  });

  it('mounts the AuthZEN evaluations handler', async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new Hono();
    app.route('/api/permdock', permdockHandler());
    const response = await app.request('http://localhost/api/permdock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        evaluations: [
          {
            resource: { type: 'post', properties: ownPost },
            action: { name: 'update' },
          },
        ],
      }),
    });
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);
  });
});
