import type { WSContext } from 'hono/ws';

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { describe, expect, it } from 'vitest';

import { memoryRevocationFeed } from '../../src/core/revocations.ts';
import { createPermDock } from '../../src/hono/index.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

async function* posts(
  signal: AbortSignal,
): AsyncGenerator<typeof ownPost, void, undefined> {
  yield otherPost;
  yield ownPost;
  // A quiet source: parked until the connection ends.
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => {
      resolve();
    });
  });
}

describe('permdock/hono streams and sockets', () => {
  it('filters SSE items and ends the stream with a permdock event on revocation', async () => {
    const revocations = memoryRevocationFeed();
    const { connection, sse } = createPermDock(policy, {
      subject: () => memberUser,
      revocations,
    });
    const app = new Hono();
    app.get('/events', async (c) => {
      const conn = await connection(c, { permission: permissions.post.list });
      return streamSSE(c, async (stream) => {
        await sse(conn, stream, posts(conn.signal), {
          items: permissions.post.update,
          format: (post) => ({ event: 'post', data: post.id }),
        });
      });
    });
    const response = await app.request('/events');
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error('expected a body');
    }
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('event: post\ndata: p1\n\n');

    await revocations.revoke({ principal: 'u1', kind: 'session-revoked' });
    let rest = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toContain('event: permdock');
    const data = /data: (.+)/u.exec(rest)?.[1] ?? '{}';
    expect(JSON.parse(data)).toMatchObject({
      status: 401,
      detail: 'session-revoked',
    });
  });

  it('stops a parked source when the client disconnects', async () => {
    const { connection, sse } = createPermDock(policy, {
      subject: () => memberUser,
    });
    let finished = false;
    const app = new Hono();
    app.get('/events', async (c) => {
      const conn = await connection(c, { permission: permissions.post.list });
      return streamSSE(c, async (stream) => {
        await sse(conn, stream, posts(conn.signal));
        finished = true;
      });
    });
    const response = await app.request('/events');
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(finished).toBe(true);
  });

  it('closes a socket with 1008 and the problem type when the connection aborts', async () => {
    const revocations = memoryRevocationFeed();
    const { connection, socket } = createPermDock(policy, {
      subject: () => memberUser,
      revocations,
    });
    const app = new Hono();
    const closes: [number | undefined, string | undefined][] = [];
    const opened: string[] = [];
    app.get('/ws', async (c) => {
      const conn = await connection(c);
      const events = socket(conn, {
        onOpen: () => {
          opened.push('open');
        },
      });
      const ws = {
        close: (code?: number, reason?: string) => {
          closes.push([code, reason]);
        },
      } as unknown as WSContext;
      events.onOpen?.(new Event('open'), ws);
      return c.text(conn.check(permissions.post.update, ownPost).outcome);
    });
    expect(await (await app.request('/ws')).text()).toBe('granted');
    expect(opened).toEqual(['open']);
    await revocations.revoke({ principal: 'u1', kind: 'session-revoked' });
    expect(closes).toEqual([
      [1008, 'https://permdock.dev/problems/unauthenticated'],
    ]);
  });
});

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

  it('rejects a claimed Web Bot Auth signature before the handler', async () => {
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: {
        verify: true,
        keys: { lookup: () => undefined },
      },
    });
    const app = new Hono();
    app.use(permdock());
    app.get('/posts', (c) => c.json({ ok: true }));
    const response = await app.request('http://localhost/posts', {
      headers: {
        'Signature-Input':
          'sig1=("@method");created=1700000000;keyid="bot-1";alg="ed25519"',
        Signature: 'sig1=:AAAA:',
        'Signature-Agent': '"https://agents.example.com"',
      },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { readonly type: string };
    expect(body.type).toBe('https://permdock.dev/problems/invalid-signature');
  });
});
