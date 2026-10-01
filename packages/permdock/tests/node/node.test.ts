import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createPermDock, toRequest } from '../../src/node/index.ts';
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
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        }),
    ),
  );
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const server = await new Promise<Server>((resolve) => {
    const next = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : 'error');
      });
    });
    next.listen(0, '127.0.0.1', () => {
      resolve(next);
    });
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new TypeError('expected tcp address');
  }
  const base = `http://127.0.0.1:${String(address.port)}`;
  return (path, init) => fetch(`${base}${path}`, init);
}

describe('permdock/node', () => {
  it('sets a request-scoped instance and protects routes', async () => {
    const { protect, send } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const request = await listen(async (req, res) => {
      const guard = await protect(permissions.post.update, (incoming) => {
        const id = incoming.url?.split('/')[2];
        return id === 'p1' ? ownPost : otherPost;
      })(req);
      if (!guard.ok) {
        await send(res, guard.response);
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ ok: true, via: guard.permdock.subject.principal?.id }),
      );
    });

    const allowed = await request('/posts/p1', { method: 'DELETE' });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, via: 'u1' });

    const denied = await request('/posts/p2', { method: 'DELETE' });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('content-type')).toContain(
      'application/problem+json',
    );
  });

  it('answers 401 with a bare Bearer challenge to a caller without credentials', async () => {
    const { protect, send } = createPermDock(policy, {
      subject: () => null,
    });
    const request = await listen(async (req, res) => {
      const guard = await protect(permissions.post.read, () => ownPost)(req);
      if (!guard.ok) {
        await send(res, guard.response);
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    const denied = await request('/posts/p1');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('mounts the AuthZEN evaluations handler', async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const handle = permdockHandler();
    const request = await listen((req, res) => handle(req, res));
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
    // SAFETY: AuthZEN response JSON produced by the handler under test.
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);
  });

  it('does not throw when Host is missing', () => {
    // SAFETY: toRequest reads only headers, method and url from the IncomingMessage.
    const req = {
      headers: {},
      method: 'GET',
      url: '/',
    } as IncomingMessage;
    expect(() => toRequest(req)).not.toThrow();
  });

  it('leaves the body stream to a later parser until the Web body is read', async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        toRequest(req);
        setTimeout(() => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          req.on('end', () => {
            res.end();
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        }, 20);
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('no port'));
          return;
        }
        fetch(`http://127.0.0.1:${address.port}/`, {
          method: 'POST',
          body: 'whole-body',
        }).catch(reject);
      });
    });
    expect(received).toBe('whole-body');
  });
});
