import type {
  Decision,
  Permission,
  PermDock,
  Snapshot,
  TokenVerifier,
} from 'permdock';

import { snapshotFor } from 'permdock';
import { describe, expect, it } from 'vitest';

import {
  saasDoc,
  saasPermissions,
  saasPolicy,
  saasMemberships,
  saasPrincipal,
  saasProject,
} from './saas/index.ts';

export type ClientStoreStatus = 'ready' | 'pending' | 'stale' | 'server-only';

/** The client surface every UI adapter hands to components. */
export type ClientStoreDock = PermDock & {
  status(permission?: Permission, data?: unknown): ClientStoreStatus;
  refresh(query?: { readonly tenant?: string }): Promise<void>;
  clear(): void;
  subscribe(listener: () => void): () => void;
};

export type ClientStoreHandle = {
  get(): ClientStoreDock;
  /** Hydrate from a server-pushed snapshot (a Server Action result, a socket message). */
  replace(value: unknown): void;
};

export type ClientStoreFactoryOptions = {
  readonly snapshot: Snapshot | string;
  readonly snapshotUrl?: string;
  readonly endpoint?: string;
  readonly tenant?: string;
  readonly fetch: typeof fetch;
  readonly verifier?: TokenVerifier;
};

export type ClientStoreFactory = (
  options: ClientStoreFactoryOptions,
) => ClientStoreHandle;

type Call = {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
};

type Responder = (call: Call) => Promise<Response> | Response;

const p = saasPermissions;

function snapshotOf(user: string, tenant: string, tenants?: 'all'): Snapshot {
  return snapshotFor(saasPolicy, saasPrincipal(user, tenant), {
    tenant,
    ...(tenants === undefined ? {} : { tenants }),
  });
}

/** gina leads team-a in both orgs, so `doc.update` needs the endpoint in each. */
function leadSnapshot(): Snapshot {
  return snapshotFor(saasPolicy, saasPrincipal('gina', 'acme'), {
    tenant: 'acme',
    tenants: 'all',
    memberships: [
      ...saasMemberships('gina'),
      { tenant: 'globex', roles: ['viewer'] },
      { tenant: 'globex', team: 'team-a', roles: ['lead'] },
    ],
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ignore(): void {
  return undefined;
}

function deferred(): {
  readonly promise: Promise<Response>;
  readonly resolve: (response: Response) => void;
} {
  let resolve: (response: Response) => void = ignore;
  const promise = new Promise<Response>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function recorder(respond: Responder): {
  readonly fetch: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const impl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    const call = { url, method: init?.method ?? 'GET', body };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

/** Maps opaque compact tokens to snapshot claims; no key material involved. */
function stubVerifier(tokens: ReadonlyMap<string, Snapshot>): TokenVerifier {
  return {
    verify(token) {
      const snapshot = tokens.get(token);
      return Promise.resolve(
        snapshot === undefined
          ? { ok: false, reason: 'invalid-token', cause: 'invalid-signature' }
          : {
              ok: true,
              claims: { snapshot },
              header: { alg: 'ES256', typ: 'permdock-snapshot+jwt' },
            },
      );
    },
  };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function denied(): Decision {
  return {
    outcome: 'denied',
    denials: [{ role: null, reason: 'deny' }],
    alternatives: [],
  };
}

function unreachable(): Response {
  throw new Error('no request expected');
}

/**
 * Race and cache scenarios for a client snapshot store: tenant switches,
 * `replace` and `refresh`, logout and a second user during a refresh, stale
 * and signed snapshots, and endpoint answers cached per tenant. Runs against
 * the saas domain; `createStore` wraps the store an adapter ships.
 */
export function testClientStore(
  name: string,
  createStore: ClientStoreFactory,
): void {
  const acmeProject = saasProject('p1');
  const globexProject = saasProject('g1');
  const acmeDoc = saasDoc('d1');

  describe(`client store: ${name}`, () => {
    it('switches to a tenant the snapshot carries without a request', async () => {
      const net = recorder(unreachable);
      const store = createStore({
        snapshot: snapshotOf('erin', 'acme', 'all'),
        snapshotUrl: '/api/snapshot',
        tenant: 'acme',
        fetch: net.fetch,
      });
      expect(store.get().can(p.project.update, acmeProject)).toBe(true);
      await store.get().refresh({ tenant: 'globex' });
      expect(store.get().can(p.project.update, globexProject)).toBe(true);
      expect(store.get().can(p.project.update, acmeProject)).toBe(false);
      expect(store.get().status()).toBe('ready');
      expect(net.calls).toHaveLength(0);
    });

    it('fetches another tenant with one query string and commits it only on success', async () => {
      let fail = true;
      const net = recorder(() =>
        fail
          ? json({ error: 'down' }, 503)
          : json(snapshotOf('erin', 'globex')),
      );
      const store = createStore({
        snapshot: snapshotOf('erin', 'acme'),
        snapshotUrl: '/api/snapshot?v=1',
        tenant: 'acme',
        fetch: net.fetch,
      });
      await store.get().refresh({ tenant: 'globex' });
      expect(net.calls.map((call) => call.url)).toEqual([
        '/api/snapshot?v=1&tenant=globex',
      ]);
      expect(store.get().subject.principal?.tenant).toBe('acme');
      expect(store.get().can(p.project.update, acmeProject)).toBe(true);
      expect(store.get().status()).toBe('stale');

      fail = false;
      await store.get().refresh({ tenant: 'globex' });
      expect(store.get().subject.principal?.tenant).toBe('globex');
      expect(store.get().can(p.project.update, globexProject)).toBe(true);
      expect(store.get().status()).toBe('ready');
    });

    it('reports pending while a refresh is in flight', async () => {
      const gate = deferred();
      const net = recorder(() => gate.promise);
      const store = createStore({
        snapshot: snapshotOf('erin', 'acme'),
        snapshotUrl: '/api/snapshot',
        tenant: 'acme',
        fetch: net.fetch,
      });
      const pending = store.get().refresh();
      expect(store.get().status()).toBe('pending');
      gate.resolve(json(snapshotOf('erin', 'acme')));
      await pending;
      expect(store.get().status()).toBe('ready');
    });

    it('drops a refresh that resolves after logout', async () => {
      const gate = deferred();
      const net = recorder(() => gate.promise);
      const store = createStore({
        snapshot: snapshotOf('erin', 'acme'),
        snapshotUrl: '/api/snapshot',
        tenant: 'acme',
        fetch: net.fetch,
      });
      const pending = store.get().refresh();
      store.get().clear();
      gate.resolve(json(snapshotOf('erin', 'acme')));
      await pending;
      await settle();
      expect(store.get().subject.principal).toBeNull();
      expect(store.get().can(p.project.read, acmeProject)).toBe(false);
      expect(store.get().status()).toBe('server-only');
    });

    it('drops a refresh for the previous user after a replace', async () => {
      const gate = deferred();
      const net = recorder(() => gate.promise);
      const store = createStore({
        snapshot: snapshotOf('erin', 'acme'),
        snapshotUrl: '/api/snapshot',
        tenant: 'acme',
        fetch: net.fetch,
      });
      const pending = store.get().refresh({ tenant: 'globex' });
      store.replace(snapshotOf('bob', 'acme'));
      gate.resolve(json(snapshotOf('erin', 'globex')));
      await pending;
      await settle();
      expect(store.get().subject.principal?.id).toBe('bob');
      expect(store.get().subject.principal?.tenant).toBe('acme');
      expect(store.get().can(p.project.update, globexProject)).toBe(false);
    });

    it('marks an expired snapshot stale until a fresh one replaces it', () => {
      const net = recorder(unreachable);
      const store = createStore({
        snapshot: { ...snapshotOf('erin', 'acme'), expiresAt: 1 },
        tenant: 'acme',
        fetch: net.fetch,
      });
      expect(store.get().status()).toBe('stale');
      expect(store.get().status(p.project.read, acmeProject)).toBe('stale');
      store.replace(snapshotOf('erin', 'acme'));
      expect(store.get().status()).toBe('ready');
    });

    it('boots a signed snapshot through the verifier', async () => {
      const token = 'header.seed.signature';
      const net = recorder(unreachable);
      const store = createStore({
        snapshot: token,
        tenant: 'acme',
        fetch: net.fetch,
        verifier: stubVerifier(new Map([[token, snapshotOf('erin', 'acme')]])),
      });
      await settle();
      expect(store.get().subject.principal?.id).toBe('erin');
      expect(store.get().can(p.project.update, acmeProject)).toBe(true);
      expect(store.get().status()).toBe('ready');
    });

    it('rejects a signed snapshot the verifier refuses', async () => {
      const net = recorder(unreachable);
      const store = createStore({
        snapshot: 'header.forged.signature',
        tenant: 'acme',
        fetch: net.fetch,
        verifier: stubVerifier(new Map()),
      });
      await settle();
      expect(store.get().subject.principal).toBeNull();
      expect(store.get().can(p.project.read, acmeProject)).toBe(false);
    });

    it('verifies a signed refresh response', async () => {
      const seed = 'header.seed.signature';
      const next = 'header.next.signature';
      const net = recorder(() => json(next));
      const store = createStore({
        snapshot: seed,
        snapshotUrl: '/api/snapshot',
        tenant: 'acme',
        fetch: net.fetch,
        verifier: stubVerifier(
          new Map([
            [seed, snapshotOf('erin', 'acme')],
            [next, snapshotOf('erin', 'globex')],
          ]),
        ),
      });
      await settle();
      await store.get().refresh({ tenant: 'globex' });
      await settle();
      expect(store.get().subject.principal?.tenant).toBe('globex');
      expect(store.get().can(p.project.update, globexProject)).toBe(true);
    });

    it('caches endpoint answers per tenant and settles the store status', async () => {
      const net = recorder((call) => {
        const body = call.body as { readonly evaluations: readonly unknown[] };
        return json({
          evaluations: body.evaluations.map(() => ({
            decision: false,
            context: { permdock: denied() },
          })),
        });
      });
      const store = createStore({
        snapshot: leadSnapshot(),
        endpoint: '/api/permdock',
        tenant: 'acme',
        fetch: net.fetch,
      });
      expect(store.get().status(p.doc.update, acmeDoc)).toBe('pending');
      await settle();
      expect(store.get().status(p.doc.update, acmeDoc)).toBe('ready');
      expect(store.get().status()).toBe('ready');
      expect(net.calls).toHaveLength(1);

      store.get().status(p.doc.update, acmeDoc);
      await settle();
      expect(net.calls).toHaveLength(1);

      await store.get().refresh({ tenant: 'globex' });
      const sameIdInGlobex = { ...acmeDoc, orgId: 'globex' };
      expect(store.get().status(p.doc.update, sameIdInGlobex)).toBe('pending');
      await settle();
      expect(net.calls).toHaveLength(2);
    });

    it('forgets endpoint answers when a new snapshot arrives', async () => {
      const net = recorder((call) => {
        const body = call.body as { readonly evaluations: readonly unknown[] };
        return json({
          evaluations: body.evaluations.map(() => ({
            decision: false,
            context: { permdock: denied() },
          })),
        });
      });
      const store = createStore({
        snapshot: snapshotOf('gina', 'acme'),
        endpoint: '/api/permdock',
        tenant: 'acme',
        fetch: net.fetch,
      });
      store.get().status(p.doc.update, acmeDoc);
      await settle();
      expect(net.calls).toHaveLength(1);
      store.replace(snapshotOf('gina', 'acme'));
      expect(store.get().status(p.doc.update, acmeDoc)).toBe('pending');
      await settle();
      expect(net.calls).toHaveLength(2);
    });

    it('does not notify subscribers synchronously from a status read', () => {
      const net = recorder(() => json({ evaluations: [] }));
      const store = createStore({
        snapshot: snapshotOf('gina', 'acme'),
        endpoint: '/api/permdock',
        tenant: 'acme',
        fetch: net.fetch,
      });
      let notified = 0;
      store.get().subscribe(() => {
        notified += 1;
      });
      store.get().status(p.doc.update, acmeDoc);
      expect(notified).toBe(0);
    });
  });
}
