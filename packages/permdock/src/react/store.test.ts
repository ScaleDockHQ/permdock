import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Decision } from '../core/decision.ts';
import type { Snapshot, TokenVerifier } from '../core/interfaces.ts';

import { emptySnapshot } from '../core/from-snapshot.ts';
import { createClientStore } from './store.ts';

const required: Decision = {
  outcome: 'approval-required',
  grant: {
    permission: 'post.publish',
    role: 'member',
    approval: { by: ['editor'] },
  },
  token: 'pd1.token/one',
} as unknown as Decision;

function signedIn(id: string): Snapshot {
  return {
    ...emptySnapshot(),
    subject: { principal: { id, roles: [] }, context: {} },
  } as Snapshot;
}

function ignore(): void {
  return undefined;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe('createClientStore approvals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls the approvals handler until the request resolves', async () => {
    const urls: string[] = [];
    const statuses = ['pending', 'pending', 'approved'];
    const store = createClientStore({
      snapshot: signedIn('u1'),
      approvals: '/api/approvals',
      server: false,
      fetch: (input) => {
        urls.push(String(input));
        return Promise.resolve(
          json({ status: statuses.shift() ?? 'approved' }),
        );
      },
    });
    const stop = store.subscribe(() => undefined);
    expect(store.approvalState(required)).toBe('required');
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.approvalState(required)).toBe('pending');
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.approvalState(required)).toBe('approved');
    const calls = urls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(urls).toHaveLength(calls);
    expect(urls[0]).toBe('/api/approvals/pd1.token%2Fone');
    stop();
  });

  it('stops polling when nothing subscribes and after clear', async () => {
    let calls = 0;
    const store = createClientStore({
      snapshot: signedIn('u1'),
      approvals: '/api/approvals',
      server: false,
      fetch: () => {
        calls += 1;
        return Promise.resolve(json({ status: 'pending' }));
      },
    });
    const stop = store.subscribe(() => undefined);
    store.approvalState(required);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(1);
    store.get().clear();
    expect(store.approvalState(required)).toBe('required');
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
  });

  it('never polls without an approvals URL or while rendering on the server', async () => {
    let calls = 0;
    const fetch = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(json({ status: 'approved' }));
    };
    const local = createClientStore({
      snapshot: signedIn('u1'),
      server: false,
      fetch,
    });
    const onServer = createClientStore({
      snapshot: signedIn('u1'),
      approvals: '/api/approvals',
      fetch,
    });
    local.subscribe(() => undefined);
    onServer.subscribe(() => undefined);
    local.approvalState(required);
    onServer.approvalState(required);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(0);
  });

  it('marks a request pending once it is sent', async () => {
    const store = createClientStore({
      snapshot: signedIn('u1'),
      approvals: '/api/approvals',
      server: false,
      fetch: () => Promise.resolve(json({ status: 'pending' })),
    });
    await store.requestApproval(required, 'please');
    expect(store.approvalState(required)).toBe('pending');
    expect(
      store.approvalState({
        outcome: 'denied',
        denials: [],
        alternatives: [],
      }),
    ).toBe('not-needed');
  });
});

describe('createClientStore snapshot sources', () => {
  it('stays pending until a followed promise settles', async () => {
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
    });
    let resolve: (value: Snapshot) => void = ignore;
    store.follow(
      new Promise<Snapshot>((settle) => {
        resolve = settle;
      }),
    );
    expect(store.get().status()).toBe('pending');
    resolve(signedIn('u1'));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().status()).toBe('ready');
    expect(store.get().subject.principal?.id).toBe('u1');
  });

  it('drops a followed promise that settles after a replace', async () => {
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
    });
    let resolve: (value: Snapshot) => void = ignore;
    store.follow(
      new Promise<Snapshot>((settle) => {
        resolve = settle;
      }),
    );
    store.replace(signedIn('u2'));
    resolve(signedIn('u1'));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().subject.principal?.id).toBe('u2');
    expect(store.get().status()).toBe('ready');
  });

  it('fails closed when a followed promise rejects', async () => {
    const store = createClientStore({
      snapshot: signedIn('u1'),
      server: false,
    });
    store.follow(Promise.reject(new Error('offline')));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().subject.principal).toBeNull();
    expect(store.get().status()).toBe('server-only');
  });

  it('verifies a signed snapshot passed to replace', async () => {
    const verifier: TokenVerifier = {
      verify: (token) =>
        Promise.resolve(
          token === 'a.b.c'
            ? {
                ok: true,
                claims: { snapshot: signedIn('u3') },
                header: { alg: 'ES256' },
              }
            : { ok: false, reason: 'invalid-token', cause: 'malformed' },
        ),
    };
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
      verifier,
    });
    store.replace('a.b.c');
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().subject.principal?.id).toBe('u3');
  });
});
