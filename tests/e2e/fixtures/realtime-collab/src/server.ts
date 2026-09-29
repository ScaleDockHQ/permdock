import type { WebSocketServerLike } from '@hono/node-server';
import type { Context } from 'hono';
import type { Connection } from 'permdock/server';

import { serve, upgradeWebSocket } from '@hono/node-server';
import {
  findOrg,
  handleSaasRoute,
  readSession,
  saasSubject,
} from '@permdock/e2e-saas-kit';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { type CustomRole, type Decision, memoryRevocationFeed } from 'permdock';
import { createPermDock } from 'permdock/hono';
import { saasPermissions as p, saasPolicy } from 'permdock/testing/saas';
import { WebSocketServer } from 'ws';

import { editsOf, findDoc, resetDocs, textOf, writeText } from './docs.ts';
import { page } from './page.ts';

const PORT = 3507;

type Peer = { readonly connection: Connection; send(message: unknown): void };

const rooms = new Map<string, Set<Peer>>();
const revocations = memoryRevocationFeed();

function room(id: string): Set<Peer> {
  let peers = rooms.get(id);
  if (peers === undefined) {
    peers = new Set();
    rooms.set(id, peers);
  }
  return peers;
}

function reasonOf(decision: Decision): string {
  return decision.outcome === 'denied'
    ? (decision.denials[0]?.reason ?? 'denied')
    : decision.outcome;
}

function textFrom(data: unknown): string | undefined {
  if (typeof data !== 'string') {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(data);
    const text = (value as { text?: unknown } | null)?.text;
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

function docOf(c: Context) {
  return findDoc(c.req.param('id'));
}

const { permdock, protect, connection, socket, sse } = createPermDock(
  saasPolicy,
  {
    subject: async (c) =>
      saasSubject(
        await readSession(c.req.header('cookie')),
        c.req.param('org') ?? '',
      ),
    tenant: (c) => c.req.param('org'),
    customRoles: {
      rolesFor: (tenant): CustomRole[] => [
        ...(findOrg(tenant)?.customRoles ?? []),
      ],
    },
    revocations,
  },
);

const app = new Hono()
  .post('/api/test/reset', async (c) => {
    resetDocs();
    return (await handleSaasRoute(c.req.raw)) ?? c.notFound();
  })
  .post('/api/test/set-role', async (c) => {
    const input = (await c.req.raw.clone().json()) as {
      org?: unknown;
      user?: unknown;
    };
    const response = await handleSaasRoute(c.req.raw);
    if (
      response?.ok === true &&
      typeof input.user === 'string' &&
      typeof input.org === 'string'
    ) {
      await revocations.revoke({
        principal: input.user,
        tenant: input.org,
        kind: 'changed',
      });
    }
    return response ?? c.notFound();
  })
  .post('/api/logout', async (c) => {
    const session = await readSession(c.req.header('cookie'));
    if (session !== null) {
      await revocations.revoke({
        principal: session.sub,
        kind: 'session-revoked',
      });
    }
    return (await handleSaasRoute(c.req.raw)) ?? c.notFound();
  })
  .get('/', (c) => c.html(page))
  .use('/:org/docs/:id/*', permdock())
  .get(
    '/:org/docs/:id/ws',
    protect(p.doc.read, docOf),
    upgradeWebSocket(async (c) => {
      const id = c.req.param('id') ?? '';
      const open = await connection(c, {
        permission: p.doc.read,
        data: () => findDoc(id),
      });
      const by = open.permdock.subject.principal?.id ?? '';
      const peer: Peer = { connection: open, send: () => undefined };
      return socket(open, {
        onOpen: (_event, ws) => {
          peer.send = (message) => {
            ws.send(JSON.stringify(message));
          };
          room(id).add(peer);
          peer.send({ type: 'doc', text: textOf(id) });
        },
        onMessage: (event) => {
          const decision = open.check(p.doc.update, findDoc(id));
          const text = textFrom(event.data);
          if (decision.outcome !== 'granted' || text === undefined) {
            peer.send({ type: 'denied', reason: reasonOf(decision) });
            return;
          }
          writeText({ docId: id, by }, text);
          for (const other of room(id)) {
            if (
              other.connection.check(p.doc.read, findDoc(id)).outcome ===
              'granted'
            ) {
              other.send({ type: 'doc', text });
            }
          }
        },
        onClose: () => {
          room(id).delete(peer);
        },
      });
    }),
  )
  .get('/:org/docs/:id/events', protect(p.doc.read, docOf), async (c) => {
    const id = c.req.param('id');
    const open = await connection(c, {
      permission: p.doc.read,
      data: () => findDoc(id),
    });
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'ready', data: '' });
      await sse(open, stream, editsOf(id, open.signal), {
        items: p.doc.read,
        unwrap: (edit) => findDoc(edit.docId),
      });
    });
  })
  .all('*', async (c) => (await handleSaasRoute(c.req.raw)) ?? c.notFound());

serve({
  fetch: app.fetch,
  port: PORT,
  hostname: '127.0.0.1',
  // `ws` types `options.noServer` as optional; the adapter wants it set.
  websocket: {
    server: new WebSocketServer({
      noServer: true,
    }) as unknown as WebSocketServerLike,
  },
});
