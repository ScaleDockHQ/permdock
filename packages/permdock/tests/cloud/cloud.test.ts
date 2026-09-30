import { describe, expect, it } from 'vitest';

import type { ApprovalRequest } from '../../src/approvals/types.ts';
import type { SinkEvent, Snapshot } from '../../src/core/interfaces.ts';
import type { Subject } from '../../src/core/subject.ts';

import { isApprovalError } from '../../src/approvals/errors.ts';
import { memoryApprovalStore } from '../../src/approvals/store.ts';
import { cloud, cloudEndpoints } from '../../src/cloud/create.ts';
import { joseTokenSigner } from '../../src/jwt/signer.ts';
import { joseTokenVerifier } from '../../src/jwt/verifier.ts';

const CLOUD_URL = 'https://cloud.permdock.test';
const KEY = 'env-key';
const SNAPSHOT: Snapshot = {
  v: 1,
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
    const consume = /^\/approvals\/([^/]+)\/consume$/u.exec(path);
    if (method === 'POST' && consume?.[1] !== undefined) {
      const next = store.consume(decodeURIComponent(consume[1]));
      return next === null ? json({}, 409) : json(next);
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
          session: url.searchParams.get('session') ?? undefined,
          limit:
            url.searchParams.get('limit') === null
              ? undefined
              : Number(url.searchParams.get('limit')),
          cursor: url.searchParams.get('cursor') ?? undefined,
        }),
      );
    }
    if (method === 'POST' && path === '/approvals/cancel') {
      const body = (await request.json()) as {
        readonly filter: Parameters<typeof store.cancel>[0];
        readonly by: string;
        readonly note?: string;
      };
      return json({
        cancelled: store.cancel(
          body.filter,
          body.note === undefined
            ? { by: body.by }
            : { by: body.by, note: body.note },
        ),
      });
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
      expect(request.headers.get('accept')).toBe('application/jwt');
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
    const previousUrl = env['PERMDOCK_CLOUD_URL'];
    const previousKey = env['PERMDOCK_CLOUD_KEY'];
    env['PERMDOCK_CLOUD_URL'] = CLOUD_URL;
    env['PERMDOCK_CLOUD_KEY'] = KEY;
    try {
      const client = cloud({ fetch: fakeCloud().fetch });
      expect(Object.isFrozen(client)).toBe(true);
    } finally {
      if (previousUrl === undefined) {
        delete env['PERMDOCK_CLOUD_URL'];
      } else {
        env['PERMDOCK_CLOUD_URL'] = previousUrl;
      }
      if (previousKey === undefined) {
        delete env['PERMDOCK_CLOUD_KEY'];
      } else {
        env['PERMDOCK_CLOUD_KEY'] = previousKey;
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
    expect(await client.approvals.list({})).toEqual({ items: [] });
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

  it('bounds the re-queue while the Cloud is unreachable, oldest first', async () => {
    let online = false;
    const delivered: SinkEvent[][] = [];
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      flushAt: 1,
      capacity: 3,
      fetch: async (input, init) => {
        if (!online) {
          throw new Error('offline');
        }
        const body = (await new Request(input, init).json()) as {
          readonly events: SinkEvent[];
        };
        delivered.push(body.events);
        return new Response(null, { status: 204 });
      },
    });
    const event = (id: string): SinkEvent => ({
      type: 'directory',
      at: new Date().toISOString(),
      source: 'scim',
      operation: 'create',
      tenant: 'o_acme',
      resource: { type: 'User', id },
      credential: { kind: 'token' },
    });
    for (const id of ['u_1', 'u_2', 'u_3', 'u_4', 'u_5']) {
      await client.sink.write([event(id)]);
    }
    online = true;
    await client.sink.flush?.();
    expect(
      delivered
        .flat()
        .map((item) => (item.type === 'directory' ? item.resource.id : '')),
    ).toEqual(['u_3', 'u_4', 'u_5']);
  });

  it('flushes decision batches and refuses an unsigned snapshot', async () => {
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
    await expect(client.snapshots.get()).rejects.toThrow(/unsigned/);
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
    expect(listed.items.some((item) => item.token === 'opaque-token')).toBe(
      true,
    );
    await client.approvals.create({ ...request, token: 'second-token' });
    const first = await client.approvals.list({ status: 'pending', limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.next).toBeTypeOf('string');
    const second = await client.approvals.list({
      status: 'pending',
      limit: 1,
      cursor: first.next!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.token).not.toBe(first.items[0]?.token);
    expect(second.next).toBeUndefined();
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

  it('filters by session and cancels pending approvals over HTTP', async () => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: fakeCloud().fetch,
    });
    const pending = (token: string, session: string): ApprovalRequest => ({
      v: 1,
      token,
      permission: 'post.delete',
      scope: 'post:delete',
      resource: { type: 'post', id: token },
      subject: { principal: { id: 'u_1', roles: ['member'] }, session },
      detail: 'post.delete requires human approval.',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: 'pending',
    });
    await client.approvals.create(pending('t_a', 'sid-a'));
    await client.approvals.create(pending('t_b', 'sid-b'));
    const bySession = await client.approvals.list({ session: 'sid-a' });
    expect(bySession.items.map((item) => item.token)).toEqual(['t_a']);
    expect(
      await client.approvals.cancel?.(
        { session: 'sid-a' },
        { by: 'system:ssf', note: 'session revoked' },
      ),
    ).toBe(1);
    expect((await client.approvals.get('t_a'))?.status).toBe('rejected');
    expect((await client.approvals.get('t_b'))?.status).toBe('pending');
  });

  it('throws when the Cloud rejects a cancel', async () => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: () => Promise.resolve(new Response(null, { status: 500 })),
    });
    await expect(
      client.approvals.cancel?.({ tenant: 'o_1' }, { by: 'admin' }),
    ).rejects.toThrow(/cancel/);
  });

  it('resumes an approval once through the Cloud store', async () => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: fakeCloud().fetch,
    });
    const request: ApprovalRequest = {
      v: 1,
      token: 'pd1.v2',
      permission: 'post.delete',
      scope: 'post:delete',
      resource: { type: 'post', id: '42' },
      subject: { principal: { id: 'u_1', roles: ['member'] } },
      detail: 'post.delete requires human approval.',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: 'pending',
    };
    await client.approvals.create(request);
    expect(await client.approvals.get('pd1.v2')).toEqual(request);
    await client.approvals.resolve('pd1.v2', {
      status: 'approved',
      by: { principal: { id: 'u_9', roles: ['admin'] }, context: {} },
    });
    expect((await client.approvals.consume('pd1.v2'))?.consumedAt).toEqual(
      expect.any(String),
    );
    expect(await client.approvals.consume('pd1.v2')).toBeNull();
  });

  it('verifies the signed policy document and keeps the last good one', async () => {
    const PRIVATE_JWK = {
      crv: 'Ed25519',
      d: 'qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4',
      x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
      kty: 'OKP',
      kid: '2026-09',
      alg: 'Ed25519',
    };
    const { d: _d, ...publicJwk } = PRIVATE_JWK;
    const ENV_URL = `${CLOUD_URL}/v1/environments/production`;
    const signer = joseTokenSigner({
      key: { ...PRIVATE_JWK },
      alg: 'Ed25519',
      kid: '2026-09',
      issuer: ENV_URL,
    });
    const foreign = joseTokenSigner({
      key: { ...PRIVATE_JWK },
      alg: 'Ed25519',
      kid: '2026-09',
      issuer: 'https://elsewhere.example',
    });
    const policy = {
      v: 1,
      id: 'doc_1',
      fingerprint: 'fp_1',
      catalog: 'cat_1',
      issuedAt: 1,
      grants: [],
    };
    const good = await signer.sign(
      { policy },
      { typ: 'permdock-policy+jwt', audience: ENV_URL },
    );
    const wrongTyp = await signer.sign(
      { policy: { ...policy, id: 'doc_2' } },
      { typ: 'permdock-snapshot+jwt', audience: ENV_URL },
    );
    const appAudience = await signer.sign(
      { policy: { ...policy, id: 'doc_3' } },
      { typ: 'permdock-policy+jwt', audience: 'https://app.example.com' },
    );
    const wrongIssuer = await foreign.sign(
      { policy: { ...policy, id: 'doc_4' } },
      { typ: 'permdock-policy+jwt', audience: ENV_URL },
    );
    const bodies = [
      good,
      wrongTyp,
      appAudience,
      wrongIssuer,
      JSON.stringify(policy),
    ];
    const paths: string[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      paths.push(new URL(request.url).pathname);
      return Promise.resolve(
        new Response(bodies.shift() ?? '', { status: 200 }),
      );
    };
    const verifier = joseTokenVerifier({
      jwks: { keys: [publicJwk] },
      algorithms: ['Ed25519'],
    });
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: fetchImpl,
      verifier,
    });
    expect(client.issuer).toBe(ENV_URL);
    expect(client.jwks).toBe(`${ENV_URL}/.well-known/jwks.json`);
    expect(client.policies.current()).toBeNull();
    await client.policies.refresh();
    expect(client.policies.current()?.id).toBe('doc_1');
    for (let index = 0; index < 4; index += 1) {
      await client.policies.refresh();
      expect(client.policies.current()?.id).toBe('doc_1');
    }
    expect(paths).toEqual(
      Array.from({ length: 5 }, () => '/v1/environments/production/policy'),
    );
  });

  it('resolves the environment endpoints like cloud()', () => {
    expect(
      cloudEndpoints({ url: `${CLOUD_URL}/`, environment: 'pre view' }),
    ).toEqual({
      issuer: `${CLOUD_URL}/v1/environments/pre%20view`,
      jwks: `${CLOUD_URL}/v1/environments/pre%20view/.well-known/jwks.json`,
    });
  });

  it('never applies a policy document without a verifier', async () => {
    let calls = 0;
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('a.b.c'));
      },
    });
    await client.policies.refresh();
    expect(client.policies.current()).toBeNull();
    expect(calls).toBe(0);
  });
});
