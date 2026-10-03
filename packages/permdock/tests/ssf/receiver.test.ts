import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  TokenFailureCause,
  TokenVerifier,
} from '../../src/core/interfaces.ts';
import type { RevocationEvent } from '../../src/core/revocations.ts';
import type {
  ReplayStore,
  SetSubject,
  SsfAuditEvent,
  SsfPermDockOptions,
  SsfReceiver,
} from '../../src/ssf/types.ts';

import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';
import { memoryRevocationFeed } from '../../src/core/revocations.ts';
import {
  asSubject,
  eventSession,
  eventSubject,
  setSubjectFromClaims,
  subjectSession,
} from '../../src/ssf/claims.ts';
import { BACKCHANNEL_LOGOUT_EVENT, caepName } from '../../src/ssf/events.ts';
import { createPermDock, memoryReplayStore } from '../../src/ssf/index.ts';
import { contentType, errForCause, parseEvery } from '../../src/ssf/wire.ts';

const permissions = definePermissions({
  post: resource(z.object({ id: z.string() }), { id: 'id', actions: ['read'] }),
});
const policy = definePolicy(permissions, {
  roles: [role('member', [allow(permissions.post.read)])],
  subject: () => ({ id: 'u1', roles: ['member'] }),
});

const ISSUER = 'https://login.example.com';
const AUDIENCE = 'https://app.example.com/ssf';
const CAEP = 'https://schemas.openid.net/secevent/caep/event-type/';
const NOW = 1_800_000_000;

/** Tokens are `ok:<json claims>` or `fail:<cause>`. */
const fakeVerifier: TokenVerifier = {
  verify(token) {
    if (token.startsWith('fail:')) {
      // SAFETY: the test encodes a TokenFailureCause after the prefix.
      const cause = token.slice(5) as TokenFailureCause;
      return Promise.resolve({ ok: false, reason: 'invalid-token', cause });
    }
    const claims: unknown = JSON.parse(token.slice(3));
    // SAFETY: the test encodes a JSON claims object after the prefix.
    return Promise.resolve({
      ok: true,
      claims: claims as Record<string, never>,
      header: { alg: 'EdDSA' },
    });
  },
};

function set(claims: Record<string, unknown>): string {
  return `ok:${JSON.stringify({ iss: ISSUER, jti: 'j1', iat: NOW, ...claims })}`;
}

function receiverOf(options: Partial<SsfPermDockOptions> = {}): {
  readonly receiver: SsfReceiver;
  readonly audit: SsfAuditEvent[];
} {
  const { receiver } = createPermDock(policy, {
    issuer: ISSUER,
    audience: AUDIENCE,
    verifier: fakeVerifier,
    subject: (subject: SetSubject) =>
      typeof subject['sub'] === 'string' ? subject['sub'] : null,
    ...options,
  });
  const audit: SsfAuditEvent[] = [];
  receiver.on('event', (event) => {
    audit.push(event);
  });
  return { receiver, audit };
}

function push(
  body: string,
  init: { method?: string; type?: string } = {},
): Request {
  return new Request(AUDIENCE, {
    method: init.method ?? 'POST',
    headers: {
      'content-type': init.type ?? 'application/secevent+jwt; charset=utf-8',
    },
    ...(init.method === 'GET' ? {} : { body }),
  });
}

function logout(
  token: string | undefined,
  init: { method?: string; type?: string } = {},
): Request {
  const body =
    token === undefined
      ? ''
      : new URLSearchParams({ logout_token: token }).toString();
  return new Request(`${AUDIENCE}/logout`, {
    method: init.method ?? 'POST',
    headers: {
      'content-type': init.type ?? 'application/x-www-form-urlencoded',
    },
    ...(init.method === 'GET' ? {} : { body }),
  });
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createPermDock options', () => {
  it('requires an audience and an issuer or discovery', () => {
    // SAFETY: deliberately omits the required audience to exercise option validation.
    expect(() =>
      createPermDock(policy, {
        verifier: fakeVerifier,
        subject: () => 'u',
        issuer: ISSUER,
      } as never),
    ).toThrow(/audience/);
    expect(() =>
      createPermDock(policy, {
        verifier: fakeVerifier,
        subject: () => 'u',
        audience: AUDIENCE,
      }),
    ).toThrow(/issuer or discovery/);
  });

  it('accepts a JWKS URL string', () => {
    expect(
      createPermDock(policy, {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: 'https://login.example.com/jwks',
        subject: () => 'u',
      }).receiver,
    ).toBeDefined();
  });
});

describe('receiver.push transport', () => {
  it.each<[string, Request, unknown]>([
    [
      'a GET',
      push('', { method: 'GET' }),
      { err: 'invalid_request', description: 'POST required' },
    ],
    [
      'a JSON body',
      push('x', { type: 'application/json' }),
      {
        err: 'invalid_request',
        description: 'application/secevent+jwt required',
      },
    ],
    [
      'an empty body',
      push('   '),
      { err: 'invalid_request', description: 'empty body' },
    ],
  ])('refuses %s', async (_label, request, body) => {
    const { receiver } = receiverOf();
    const response = await receiver.push(request);
    expect({ status: response.status, body: await json(response) }).toEqual({
      status: 400,
      body,
    });
  });

  it('refuses a request without a content type', async () => {
    const { receiver } = receiverOf();
    const request = new Request(AUDIENCE, {
      method: 'POST',
      body: new Uint8Array([1]),
    });
    expect((await receiver.push(request)).status).toBe(400);
  });

  it.each<[string, string, string]>([
    ['missing jti', set({ jti: '' }), 'missing jti'],
    ['missing iat', set({ iat: 'yesterday' }), 'missing iat'],
    ['missing events', set({ events: 'x' }), 'missing events'],
  ])('refuses a SET with %s', async (_label, token, description) => {
    const { receiver } = receiverOf();
    expect(await json(await receiver.push(push(token)))).toEqual({
      err: 'invalid_request',
      description,
    });
  });

  it.each<[TokenFailureCause, string]>([
    ['wrong-audience', 'invalid_audience'],
    ['wrong-issuer', 'invalid_issuer'],
    ['expired', 'invalid_request'],
  ])('maps a %s failure to %s', async (cause, err) => {
    const { receiver, audit } = receiverOf();
    expect(await json(await receiver.push(push(`fail:${cause}`)))).toEqual({
      err,
      description: cause,
    });
    expect(audit).toEqual([{ type: 'verification-failed', err, cause }]);
  });
});

describe('receiver.push events', () => {
  it('takes the subject and session from a pre-1.0 CAEP event', async () => {
    const seen: unknown[] = [];
    const { receiver } = receiverOf({
      subject: (subject, meta) => ({
        ...meta,
        id: String(subject['email']),
        issuer: 'custom',
      }),
      onEvent: { 'session-revoked': (input) => void seen.push(input) },
    });
    const response = await receiver.push(
      push(
        set({
          sub: undefined,
          events: {
            [`${CAEP}session-revoked`]: {
              subject: { format: 'email', email: 'a@b.c' },
              sid: 's-9',
              event_timestamp: NOW,
            },
          },
        }),
      ),
    );
    expect(response.status).toBe(202);
    expect(seen).toMatchObject([
      {
        subject: { id: 'a@b.c', session: 's-9', issuer: 'custom' },
        event_timestamp: NOW,
        type: 'session-revoked',
      },
    ]);
  });

  it('falls back to an opaque subject and a complex subject session', async () => {
    const subjects: SetSubject[] = [];
    const sessions: unknown[] = [];
    const { receiver } = receiverOf({
      subject: (subject, meta) => {
        subjects.push(subject);
        sessions.push(meta?.session);
        return 'u1';
      },
      onEvent: { '*': () => undefined },
    });
    await receiver.push(
      push(
        set({
          jti: 'j-a',
          events: { [`${CAEP}credential-change`]: 'not-a-record' },
        }),
      ),
    );
    await receiver.push(
      push(
        set({
          jti: 'j-b',
          sub_id: {
            format: 'complex',
            session: { format: 'opaque', id: 'sess-1' },
          },
          events: { [`${CAEP}token-claims-change`]: { session: 'explicit' } },
        }),
      ),
    );
    await receiver.push(
      push(
        set({
          jti: 'j-c',
          events: { [`${CAEP}assurance-level-change`]: { session: '' } },
        }),
      ),
    );
    expect(subjects).toEqual([
      { format: 'opaque', id: 'j-a' },
      { format: 'complex', session: { format: 'opaque', id: 'sess-1' } },
      { format: 'opaque', id: 'j-c' },
    ]);
    expect(sessions).toEqual([undefined, 'explicit', undefined]);
  });

  it.each<[string, unknown]>([
    ['an empty string', ''],
    ['an empty id', { id: '' }],
    ['undefined', undefined],
  ])(
    'treats a mapper returning %s as an unknown subject',
    async (_label, mapped) => {
      const handler = vi.fn<() => void>();
      const { receiver, audit } = receiverOf({
        // SAFETY: the mapper deliberately returns each degenerate value under test.
        subject: () => mapped as string,
        onEvent: { 'session-revoked': handler },
      });
      const response = await receiver.push(
        push(set({ sub: 'u1', events: { [`${CAEP}session-revoked`]: {} } })),
      );
      expect(response.status).toBe(202);
      expect(handler).not.toHaveBeenCalled();
      expect(audit).toEqual([
        {
          type: 'session-revoked',
          transmitter: ISSUER,
          jti: 'j1',
          unknown: 'subject',
        },
      ]);
    },
  );

  it('acknowledges a known event without a handler and still publishes the revocation', async () => {
    const feed = memoryRevocationFeed();
    const revoked: RevocationEvent[] = [];
    feed.subscribe((event) => void revoked.push(event));
    const { receiver, audit } = receiverOf({ revocations: feed });
    await receiver.push(
      push(
        set({
          sub: 'u1',
          events: {
            [`${CAEP}session-revoked`]: { session: 's1' },
            [`${CAEP}device-compliance-change`]: {},
          },
        }),
      ),
    );
    expect(revoked).toEqual([
      { principal: 'u1', session: 's1', kind: 'session-revoked' },
    ]);
    expect(audit.map((event) => [event.type, event.unknown])).toEqual([
      ['session-revoked', 'event'],
      ['device-compliance-change', 'event'],
    ]);
  });

  it('survives a revocation feed that throws', async () => {
    const { receiver } = receiverOf({
      revocations: {
        subscribe: () => () => undefined,
        revoke: () => Promise.reject(new Error('down')),
      },
      onEvent: { 'credential-change': () => undefined },
    });
    const response = await receiver.push(
      push(set({ sub: 'u1', events: { [`${CAEP}credential-change`]: {} } })),
    );
    expect(response.status).toBe(202);
  });

  it('keeps a SET without exp replay-protected until iat plus the tolerance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const remembered: (number | undefined)[] = [];
    const replay: ReplayStore = {
      seen: () => false,
      remember: (_key, expiresAt) => void remembered.push(expiresAt),
    };
    const { receiver } = receiverOf({
      replay,
      clockTolerance: 60,
      onEvent: { '*': () => undefined },
    });
    await receiver.push(
      push(set({ sub: 'u', events: { [`${CAEP}credential-change`]: {} } })),
    );
    await receiver.push(
      push(
        set({
          jti: 'j2',
          iat: NOW - 120,
          sub: 'u',
          events: { [`${CAEP}credential-change`]: {} },
        }),
      ),
    );
    await receiver.push(
      push(
        set({
          jti: 'j3',
          exp: NOW + 5,
          sub: 'u',
          events: { [`${CAEP}credential-change`]: {} },
        }),
      ),
    );
    expect(remembered).toEqual([NOW + 60, undefined, NOW + 5]);
  });
});

describe('receiver.logout', () => {
  const logoutClaims = (claims: Record<string, unknown>): string =>
    set({ events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...claims });

  it.each<[string, Request]>([
    ['a GET', logout(undefined, { method: 'GET' })],
    ['a JSON body', logout('x', { type: 'application/json' })],
    ['no logout_token', logout(undefined)],
    ['an empty logout_token', logout('')],
    [
      'no back-channel event',
      logout(set({ sub: 'u1', events: { other: {} } })),
    ],
    ['non-record events', logout(set({ sub: 'u1', events: [] }))],
    ['neither sub nor sid', logout(logoutClaims({ sub: '', sid: '' }))],
    ['a failed verification', logout('fail:invalid-signature')],
  ])('refuses %s', async (_label, request) => {
    const { receiver } = receiverOf();
    const response = await receiver.logout(request);
    expect({ status: response.status, body: await json(response) }).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
  });

  it('joins on sid alone as an opaque subject', async () => {
    const subjects: SetSubject[] = [];
    const seen: unknown[] = [];
    const { receiver } = receiverOf({
      subject: (subject) => {
        subjects.push(subject);
        return 'u1';
      },
      onEvent: { 'session-revoked': (input) => void seen.push(input.subject) },
    });
    const response = await receiver.logout(
      logout(logoutClaims({ sub: '', sid: 's-1' })),
    );
    expect(response.status).toBe(200);
    expect(subjects).toEqual([{ format: 'opaque', id: 's-1' }]);
    expect(seen).toEqual([{ id: 'u1', session: 's-1', issuer: ISSUER }]);
  });

  it('acknowledges an unknown subject and a replayed logout', async () => {
    const { receiver, audit } = receiverOf({ subject: () => null });
    const token = logoutClaims({
      sub: 'u1',
      events: { [BACKCHANNEL_LOGOUT_EVENT]: 'x' },
    });
    expect((await receiver.logout(logout(token))).status).toBe(200);
    expect((await receiver.logout(logout(token))).status).toBe(200);
    expect(audit).toEqual([
      {
        type: 'session-revoked',
        transmitter: ISSUER,
        jti: 'j1',
        unknown: 'subject',
      },
      { type: 'replay', transmitter: ISSUER, jti: 'j1', replayed: true },
    ]);
  });
});

describe('receiver.poll', () => {
  function pollFetch(sets: unknown): {
    readonly fetch: typeof fetch;
    readonly bodies: unknown[];
    readonly headers: (string | null)[];
  } {
    const bodies: unknown[] = [];
    const headers: (string | null)[] = [];
    const fetchFn = vi.fn<typeof fetch>((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      headers.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(Response.json(bodies.length === 1 ? sets : {}));
    });
    return { fetch: fetchFn, bodies, headers };
  }

  it('acks accepted SETs and reports unverifiable ones in setErrs', async () => {
    const { receiver } = receiverOf({ onEvent: { '*': () => undefined } });
    const transport = pollFetch({
      sets: {
        j1: set({ sub: 'u1', events: { [`${CAEP}credential-change`]: {} } }),
        j2: 'fail:invalid-signature',
        j3: 42,
      },
    });
    const result = await receiver.poll({
      endpoint: 'https://idp.example/poll',
      token: 'poll-token',
      fetch: transport.fetch,
    });
    expect(result).toEqual({ acked: ['j1'] });
    expect(transport.headers).toEqual([
      'Bearer poll-token',
      'Bearer poll-token',
    ]);
    expect(transport.bodies[1]).toEqual({
      acks: ['j1'],
      setErrs: { j2: { err: 'invalid_key', description: 'invalid-signature' } },
      maxEvents: 0,
      returnImmediately: true,
    });
  });

  it.each<[string, () => Promise<Response>]>([
    [
      'a failed poll',
      () => Promise.resolve(new Response('no', { status: 503 })),
    ],
    ['a body without sets', () => Promise.resolve(Response.json({ sets: [] }))],
    ['a non-object body', () => Promise.resolve(Response.json('x'))],
  ])('acks nothing after %s', async (_label, respond) => {
    const { receiver, audit } = receiverOf();
    const fetchFn = vi.fn<typeof fetch>(respond);
    expect(
      await receiver.poll({
        endpoint: 'https://idp.example/poll',
        fetch: fetchFn,
      }),
    ).toEqual({ acked: [] });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(audit.length).toBeLessThanOrEqual(1);
  });

  it('polls on an interval until stopped and reports transport errors', async () => {
    vi.useFakeTimers();
    const { receiver, audit } = receiverOf();
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error('offline')),
    );
    const handle = receiver.poll({
      endpoint: 'https://idp.example/poll',
      every: '2s',
      fetch: fetchFn,
    });
    if (!('stop' in handle)) {
      throw new Error('expected a poll handle');
    }
    await vi.advanceTimersByTimeAsync(4_100);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    handle.stop();
    handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(audit.every((event) => event.type === 'poll-failed')).toBe(true);
    expect(audit).toHaveLength(3);
  });
});

describe('SSF wire helpers', () => {
  it.each<[number | string, number]>([
    [250, 250],
    ['500ms', 500],
    ['3s', 3_000],
    ['2m', 120_000],
  ])('parseEvery(%j) is %i ms', (every, ms) => {
    expect(parseEvery(every)).toBe(ms);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5h', '1.5s', ''])(
    'parseEvery(%j) throws',
    (every) => {
      expect(() => parseEvery(every)).toThrow(TypeError);
    },
  );

  it.each<[TokenFailureCause, string]>([
    ['invalid-signature', 'invalid_key'],
    ['unknown-kid', 'invalid_key'],
    ['alg-not-allowed', 'invalid_key'],
    ['alg-none', 'invalid_key'],
    ['wrong-issuer', 'invalid_issuer'],
    ['wrong-audience', 'invalid_audience'],
    ['expired', 'invalid_request'],
    ['not-yet-valid', 'invalid_request'],
    ['wrong-token-type', 'invalid_request'],
    ['malformed', 'invalid_request'],
    ['encrypted-token', 'invalid_request'],
    ['dpop-proof-invalid', 'invalid_request'],
    ['mtls-binding-mismatch', 'invalid_request'],
    ['sender-constraint-required', 'invalid_request'],
    ['token-in-query', 'invalid_request'],
    ['invalid-claims', 'invalid_request'],
    ['invalid-chain', 'invalid_request'],
    ['jwks-unavailable', 'invalid_request'],
    ['discovery-unavailable', 'invalid_request'],
    ['discovery-mismatch', 'invalid_request'],
  ])('errForCause(%s) is %s', (cause, err) => {
    expect(errForCause(cause)).toBe(err);
  });

  it('reads the media type without parameters', () => {
    expect(
      contentType(
        new Request('https://a.example', {
          headers: { 'content-type': ' Application/JSON ; q=1' },
        }),
      ),
    ).toBe('application/json');
    expect(contentType(new Request('https://a.example'))).toBe('');
  });

  it('stops notifying a listener after it unsubscribes', async () => {
    const { receiver } = receiverOf();
    const events: SsfAuditEvent[] = [];
    const off = receiver.on('event', (event) => void events.push(event));
    await receiver.push(push('fail:expired'));
    off();
    await receiver.push(push('fail:expired'));
    expect(events).toHaveLength(1);
  });

  it('names only CAEP event types', () => {
    expect(caepName(`${CAEP}session-revoked`)).toBe('session-revoked');
    expect(caepName(`${CAEP}made-up`)).toBeUndefined();
    expect(caepName('https://other.example/session-revoked')).toBeUndefined();
  });
});

describe('SSF claim helpers', () => {
  it('merges a mapped subject with the event session and issuer', () => {
    expect(asSubject({ id: 'u', session: 'own' }, 's', 'iss')).toEqual({
      id: 'u',
      session: 'own',
      issuer: 'iss',
    });
    expect(asSubject({ id: 'u', issuer: 'mine' }, undefined, 'iss')).toEqual({
      id: 'u',
      issuer: 'mine',
    });
  });

  it.each<[Record<string, unknown>, SetSubject | undefined]>([
    [
      { sub_id: { format: 'email', email: 'a@b' } },
      { format: 'email', email: 'a@b' },
    ],
    [
      { sub_id: { email: 'a@b' }, sub: 'u1', iss: 'i' },
      { format: 'iss_sub', iss: 'i', sub: 'u1' },
    ],
    [
      { sub: 'u1', iss: 3 },
      { format: 'iss_sub', sub: 'u1' },
    ],
    [{ sub: '' }, undefined],
    [{}, undefined],
  ])('setSubjectFromClaims(%j)', (claims, subject) => {
    expect(setSubjectFromClaims(claims)).toEqual(subject);
  });

  it('reads event sessions and subjects', () => {
    expect(eventSession({ session: 's', sid: 'x' })).toBe('s');
    expect(eventSession({ session: '', sid: 'x' })).toBe('x');
    expect(eventSession({ sid: '' })).toBeUndefined();
    expect(eventSubject({ subject: { format: 'opaque', id: 'a' } })).toEqual({
      format: 'opaque',
      id: 'a',
    });
    expect(eventSubject({ subject: { id: 'a' } })).toBeUndefined();
    expect(eventSubject({ subject: 'a' })).toBeUndefined();
    expect(subjectSession({ format: 'opaque', id: 'x' })).toBeUndefined();
    expect(subjectSession({ format: 'complex', session: 'x' })).toBeUndefined();
    expect(
      subjectSession({ format: 'complex', session: { id: '' } }),
    ).toBeUndefined();
    expect(subjectSession({ format: 'complex', session: { id: 's' } })).toBe(
      's',
    );
  });

  it('evicts expired replay keys', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const store = memoryReplayStore();
    store.remember('a', NOW + 10);
    store.remember('b');
    expect(store.seen('a')).toBe(true);
    vi.setSystemTime((NOW + 11) * 1000);
    expect([store.seen('a'), store.seen('b')]).toEqual([false, true]);
  });
});
