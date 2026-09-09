import { describe, expect, it } from 'vitest';

import type { ApprovalRequest } from '../approvals/types.ts';
import type { SinkEvent, Snapshot } from '../core/interfaces.ts';
import type { Subject } from '../core/subject.ts';

import { isApprovalError } from '../approvals/errors.ts';
import { memoryApprovalStore } from '../approvals/store.ts';
import { cloud } from './create.ts';

const CLOUD_URL = 'https://cloud.permdock.test';
const KEY = 'env-key';
const SNAPSHOT: Snapshot = {
  v: 2,
  issuedAt: 1,
  subject: { principal: { id: 'u_1', roles: ['member'] }, context: {} },
  roles: ['member'],
  grants: [],
  tenants: ['o_acme'],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeCloud(options: { readonly snapshot?: Snapshot | string } = {}): {
  readonly fetch: typeof fetch;
  readonly decisions: SinkEvent[][];
} {
  const store = memoryApprovalStore();
  const decisions: SinkEvent[][] = [];
  const snapshot = options.snapshot ?? SNAPSHOT;

  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe(CLOUD_URL);
    expect(url.pathname.startsWith('/v1/environments/')).toBe(true);
    expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    const prefix = `/v1/environments/production`;
    expect(url.pathname.startsWith(prefix)).toBe(true);
    const path = url.pathname.slice(prefix.length);
    const method = request.method;

    if (method === 'POST' && path === '/approvals') {
      const record = (await request.json()) as ApprovalRequest;
      store.create(record);
      return new Response(null, { status: 204 });
    }
    const resolve = /^\/approvals\/([^/]+)\/resolve$/u.exec(path);
    if (method === 'POST' && resolve?.[1] !== undefined) {
      try {
        const next = store.resolve(
          decodeURIComponent(resolve[1]),
          (await request.json()) as Parameters<typeof store.resolve>[1],
        );
        return json(next);
      } catch (error) {
        if (isApprovalError(error)) {
          const status =
            error.code === 'approval-not-pending'
              ? 409
              : error.code === 'approval-expired'
                ? 410
                : 404;
          return json({ code: error.code }, status);
        }
        throw error;
      }
    }
    const getOne = /^\/approvals\/([^/]+)$/u.exec(path);
    if (method === 'GET' && getOne?.[1] !== undefined) {
      const loaded = store.get(decodeURIComponent(getOne[1]));
      return loaded === null
        ? new Response(null, { status: 404 })
        : json(loaded);
    }
    if (method === 'GET' && path === '/approvals') {
      return json(
        store.list({
          status: (url.searchParams.get('status') ?? undefined) as
            | ApprovalRequest['status']
            | undefined,
          principalId: url.searchParams.get('principalId') ?? undefined,
          actorId: url.searchParams.get('actorId') ?? undefined,
          tenant: url.searchParams.get('tenant') ?? undefined,
        }),
      );
    }
    if (method === 'POST' && path === '/approvals/expire') {
      const body = (await request.json()) as { readonly now?: string };
      const expired = store.expire(
        body.now === undefined ? undefined : new Date(body.now),
      );
      return json({ expired });
    }
    if (method === 'POST' && path === '/decisions') {
      const body = (await request.json()) as { readonly events: SinkEvent[] };
      decisions.push(body.events);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path === '/snapshot') {
      if (typeof snapshot === 'string') {
        return new Response(snapshot, { status: 200 });
      }
      return json(snapshot);
    }
    return new Response(null, { status: 404 });
  };

  return { fetch: fetchImpl, decisions };
}

describe('cloud', () => {
  it('throws when url or key is missing', () => {
    expect(() => cloud({})).toThrow(/requires url and key/);
    expect(() => cloud({ url: CLOUD_URL })).toThrow(/requires url and key/);
    expect(() => cloud({ key: KEY })).toThrow(/requires url and key/);
  });

  it('returns a frozen client with approvals, sink and snapshots', () => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: fakeCloud().fetch,
    });
    expect(Object.isFrozen(client)).toBe(true);
    expect(client).toEqual(
      expect.objectContaining({
        approvals: expect.any(Object),
        sink: expect.any(Object),
        snapshots: expect.any(Object),
      }),
    );
    expect(client).not.toHaveProperty('memberships');
    expect(client).not.toHaveProperty('roles');
    expect(client).not.toHaveProperty('decide');
  });

  it('reads url and key from the environment', () => {
    const env = (
      globalThis as {
        readonly process: { readonly env: Record<string, string | undefined> };
      }
    ).process.env;
    const previousUrl = env.PERMDOCK_CLOUD_URL;
    const previousKey = env.PERMDOCK_CLOUD_KEY;
    env.PERMDOCK_CLOUD_URL = CLOUD_URL;
    env.PERMDOCK_CLOUD_KEY = KEY;
    try {
      const client = cloud({ fetch: fakeCloud().fetch });
      expect(Object.isFrozen(client)).toBe(true);
    } finally {
      if (previousUrl === undefined) {
        delete env.PERMDOCK_CLOUD_URL;
      } else {
        env.PERMDOCK_CLOUD_URL = previousUrl;
      }
      if (previousKey === undefined) {
        delete env.PERMDOCK_CLOUD_KEY;
      } else {
        env.PERMDOCK_CLOUD_KEY = previousKey;
      }
    }
  });

  it('returns null from get when the API is unreachable', async () => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(await client.approvals.get('missing')).toBeNull();
    expect(await client.approvals.list({})).toEqual([]);
    expect(await client.approvals.expire()).toBe(0);
  });

  it('swallows sink delivery failures', async () => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      flushAt: 1,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(
      Promise.resolve(
        client.sink.write([
          {
            type: 'decision',
            at: new Date().toISOString(),
            outcome: 'granted',
            permission: 'post.read',
            scope: 'post:read',
            resource: { type: 'post' },
            subject: { principal: { id: 'u_1', roles: [] } },
            trusted: true,
            source: 'decide',
          },
        ]),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Promise.resolve(client.sink.flush?.()),
    ).resolves.toBeUndefined();
  });

  it('flushes decision batches and reads snapshots', async () => {
    const backend = fakeCloud();
    const client = cloud({
      url: `${CLOUD_URL}/`,
      key: KEY,
      flushAt: 1,
      fetch: backend.fetch,
    });
    const event: SinkEvent = {
      type: 'directory',
      at: new Date().toISOString(),
      source: 'scim',
      operation: 'create',
      tenant: 'o_acme',
      resource: { type: 'User', id: 'u_1' },
      credential: { kind: 'token' },
    };
    await client.sink.write([event]);
    expect(backend.decisions).toEqual([[event]]);
    expect(await client.snapshots.get()).toEqual(SNAPSHOT);
  });

  it('returns a compact JWS snapshot unchanged', async () => {
    const jws = 'aaa.bbb.ccc';
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: fakeCloud({ snapshot: jws }).fetch,
    });
    expect(await client.snapshots.get()).toBe(jws);
  });

  it('schedules flush through waitUntil when the batch is under flushAt', async () => {
    const backend = fakeCloud();
    const scheduled: Promise<void>[] = [];
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      flushAt: 8,
      waitUntil: (task) => {
        scheduled.push(task);
      },
      fetch: backend.fetch,
    });
    client.sink.write([
      {
        type: 'directory',
        at: new Date().toISOString(),
        source: 'scim',
        operation: 'patch',
        tenant: 'o_acme',
        resource: { type: 'Group', id: 'g_1' },
        credential: { kind: 'jwt', iss: 'https://idp.example' },
      },
    ]);
    expect(backend.decisions).toEqual([]);
    expect(scheduled).toHaveLength(1);
    await scheduled[0];
    expect(backend.decisions).toHaveLength(1);
  });

  it('creates, lists, resolves and expires approvals over HTTP', async () => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: fakeCloud().fetch,
    });
    const request: ApprovalRequest = {
      v: 1,
      token: 'opaque-token',
      permission: 'post.delete',
      scope: 'post:delete',
      resource: { type: 'post', id: '42' },
      subject: {
        principal: { id: 'u_1', roles: ['member'] },
        actor: { id: 'agent-1', kind: 'eve' },
      },
      detail: 'post.delete requires human approval.',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: 'pending',
    };
    await client.approvals.create(request);
    expect(await client.approvals.get('opaque-token')).toEqual(request);
    const listed = await client.approvals.list({ status: 'pending' });
    expect(listed.some((item) => item.token === 'opaque-token')).toBe(true);
    const approver: Subject = {
      principal: { id: 'u_9', roles: ['admin'] },
      context: {},
    };
    const resolved = await client.approvals.resolve('opaque-token', {
      status: 'approved',
      by: approver,
    });
    expect(resolved.status).toBe('approved');
    await expect(
      client.approvals.resolve('opaque-token', {
        status: 'rejected',
        by: approver,
      }),
    ).rejects.toThrow(/not pending/);
    await client.approvals.create({
      ...request,
      token: 'stale-token',
      status: 'pending',
    });
    const expired = await client.approvals.expire(
      new Date(Date.now() + 2 * 60 * 60 * 1000),
    );
    expect(expired).toBeGreaterThanOrEqual(1);
  });
});
