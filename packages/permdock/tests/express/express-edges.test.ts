import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { withBound } from '../../src/express/create.ts';
import { createPermDock } from '../../src/express/index.ts';
import { memberUser, permissions, policy } from '../fixtures/quick-start.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
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

describe('permdock/express edge cases', () => {
  it('protects a collection route without a loader', async () => {
    const { protect, handler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.get(
      '/posts',
      protect(permissions.post.list),
      handler((req, res) => {
        res.json({ data: req.permdockData ?? null });
      }),
    );
    const request = await listen(app);
    const response = await request('/posts');
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { data: null },
    });
  });

  it('serves the snapshot on GET from the evaluations handler', async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.use('/api/permdock', permdockHandler());
    const request = await listen(app);
    const response = await request('/api/permdock');
    expect(response.status).toBe(200);
  });
});

describe('withBound', () => {
  it('falls back for a request the adapter never bound', () => {
    const contexts = new WeakMap<globalThis.Request, express.Request>();
    expect(
      withBound(
        contexts,
        new Request('http://localhost/'),
        () => 'used',
        'fallback',
      ),
    ).toBe('fallback');
  });
});
