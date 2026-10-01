import { Elysia } from 'elysia';
import { describe, expect, it } from 'vitest';

import { memoryRevocationFeed } from '../../src/core/revocations.ts';
import { createPermDock, type ElysiaContext } from '../../src/elysia/index.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

function isElysiaContext(ctx: unknown): ctx is ElysiaContext {
  return typeof ctx === 'object' && ctx !== null && 'permdock' in ctx;
}

describe('permdock/elysia sockets', () => {
  it('shares one connection per socket, checks messages and closes with 1008 on revocation', async () => {
    const revocations = memoryRevocationFeed();
    const { connection } = createPermDock(policy, {
      subject: () => memberUser,
      revocations,
    });
    const closes: [number | undefined, string | undefined][] = [];
    const ws = {
      data: { request: new Request('http://localhost/ws') },
      close: (code?: number, reason?: string) => {
        closes.push([code, reason]);
      },
    };
    const opened = await connection(ws, { permission: permissions.post.list });
    const again = await connection({ ...ws });
    expect(again).toBe(opened);
    expect(opened.check(permissions.post.update, ownPost).outcome).toBe(
      'granted',
    );
    expect(opened.check(permissions.post.update, otherPost).outcome).toBe(
      'denied',
    );
    expect(closes).toEqual([]);
    await revocations.revoke({ principal: 'u1', kind: 'session-revoked' });
    expect(closes).toEqual([
      [1008, 'https://permdock.dev/problems/unauthenticated'],
    ]);
  });
});

describe('permdock/elysia', () => {
  it('sets a request-scoped instance and protects routes', async () => {
    const { permdock, protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new Elysia().use(permdock()).delete(
      '/posts/:id',
      (ctx) => ({
        ok: true,
        via: isElysiaContext(ctx)
          ? ctx.permdock.subject.principal?.id
          : undefined,
      }),
      {
        beforeHandle: protect(permissions.post.update, ({ params }) =>
          params?.['id'] === 'p1' ? ownPost : otherPost,
        ),
      },
    );

    const allowed = await app.handle(
      new Request('http://localhost/posts/p1', { method: 'DELETE' }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, via: 'u1' });

    const denied = await app.handle(
      new Request('http://localhost/posts/p2', { method: 'DELETE' }),
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('content-type')).toContain(
      'application/problem+json',
    );
  });

  it('answers 401 with a bare Bearer challenge to a caller without credentials', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => null,
    });
    const app = new Elysia().get('/posts/:id', () => ({ ok: true }), {
      beforeHandle: protect(permissions.post.read, () => ownPost),
    });
    const denied = await app.handle(new Request('http://localhost/posts/p1'));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('mounts the AuthZEN evaluations handler', async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new Elysia().group('/api/permdock', (group) =>
      group.use(permdockHandler()),
    );
    const response = await app.handle(
      new Request('http://localhost/api/permdock', {
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
      }),
    );
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);
  });
});
