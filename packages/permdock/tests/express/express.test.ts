import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createPermDock } from '../../src/express/index.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err === undefined) {
              resolve();
              return;
            }
            reject(err);
          });
        }),
    ),
  );
});

async function listen(
  app: ReturnType<typeof express>,
): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const server = await new Promise<Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => {
      resolve(next);
    });
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected tcp address');
  }
  const base = `http://127.0.0.1:${String(address.port)}`;
  return (path, init) => fetch(`${base}${path}`, init);
}

describe('permdock/express', () => {
  it('sets a request-scoped instance and protects routes', async () => {
    const { permdock, protect, handler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.use(permdock());
    app.delete(
      '/posts/:id',
      protect(permissions.post.update, (req) =>
        req.params['id'] === 'p1' ? ownPost : otherPost,
      ),
      handler((req, res) => {
        res.json({ ok: true, via: req.permdock.subject.principal?.id });
      }),
    );
    const request = await listen(app);

    const allowed = await request('/posts/p1', { method: 'DELETE' });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, via: 'u1' });

    const denied = await request('/posts/p2', { method: 'DELETE' });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('content-type')).toContain(
      'application/problem+json',
    );
  });

  it('answers 401 invalid_token for an anonymous caller', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => null,
    });
    const app = express();
    app.get(
      '/posts/:id',
      protect(permissions.post.read, () => ownPost),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    const request = await listen(app);
    const denied = await request('/posts/p1');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('turns a thrown assert into a problem and passes other errors on', async () => {
    const { permdock, errorHandler, handler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.use(permdock());
    app.get(
      '/posts/:id',
      handler((req) => {
        req.permdock.assert(permissions.post.update, otherPost);
      }),
    );
    app.get(
      '/boom',
      handler(() => {
        throw new Error('boom');
      }),
    );
    app.use(errorHandler());
    const request = await listen(app);

    const denied = await request('/posts/p2');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('content-type')).toContain(
      'application/problem+json',
    );

    const other = await request('/boom');
    expect(other.status).toBe(500);
  });

  it('mounts the AuthZEN evaluations handler', async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/permdock', permdockHandler());
    const request = await listen(app);
    const response = await request('/api/permdock', {
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
