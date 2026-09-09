import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { TokenVerifier } from '../core/interfaces.ts';

import { definePermissions, resource } from '../core/permissions.ts';
import { allow, definePolicy, role } from '../core/policy.ts';
import { BACKCHANNEL_LOGOUT_EVENT } from './events.ts';
import { createPermDock, memoryReplayStore } from './index.ts';

const permissions = definePermissions({
  post: resource(z.object({ id: z.string() }), {
    id: 'id',
    actions: ['read'],
  }),
});

const policy = definePolicy(permissions, {
  roles: [role('member', [allow(permissions.post.read)])],
  subject: () => ({ id: 'u1', roles: ['member'] }),
});

const ISSUER = 'https://login.example.com';
const AUDIENCE = 'https://app.example.com/ssf';
const SESSION_REVOKED =
  'https://schemas.openid.net/secevent/caep/event-type/session-revoked';
const CREDENTIAL_CHANGE =
  'https://schemas.openid.net/secevent/caep/event-type/credential-change';
const UNKNOWN_EVENT = 'https://schemas.example.com/event-type/custom';

function setRequest(token: string): Request {
  return new Request('https://app.example.com/ssf', {
    method: 'POST',
    headers: { 'content-type': 'application/secevent+jwt' },
    body: token,
  });
}

function logoutRequest(token: string): Request {
  return new Request('https://app.example.com/oidc/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ logout_token: token }).toString(),
  });
}

function verifier(
  claimsFor: (token: string) => Record<string, unknown>,
): TokenVerifier {
  return {
    async verify(token, expectations) {
      if (token.startsWith('bad-')) {
        return {
          ok: false,
          reason: 'invalid-token',
          cause: 'invalid-signature',
        };
      }
      if (token.startsWith('typ-')) {
        return {
          ok: false,
          reason: 'invalid-token',
          cause: 'wrong-token-type',
        };
      }
      const claims = claimsFor(token);
      if (
        expectations.issuer !== undefined &&
        claims.iss !== expectations.issuer
      ) {
        return { ok: false, reason: 'invalid-token', cause: 'wrong-issuer' };
      }
      if (expectations.typ === 'logout+jwt' && token.startsWith('set-')) {
        return {
          ok: false,
          reason: 'invalid-token',
          cause: 'wrong-token-type',
        };
      }
      if (expectations.typ === 'secevent+jwt' && token.startsWith('logout-')) {
        return {
          ok: false,
          reason: 'invalid-token',
          cause: 'wrong-token-type',
        };
      }
      return {
        ok: true,
        claims,
        header: { alg: 'Ed25519', typ: String(expectations.typ ?? 'jwt') },
      };
    },
  };
}

describe('createPermDock', () => {
  it('throws TypeError without verifier, jwks, or discovery', () => {
    expect(() =>
      createPermDock(policy, {
        issuer: ISSUER,
        audience: AUDIENCE,
        subject: () => 'u1',
      }),
    ).toThrow(TypeError);
  });

  it('throws TypeError without subject', () => {
    expect(() =>
      createPermDock(policy, {
        issuer: ISSUER,
        audience: AUDIENCE,
        verifier: verifier(() => ({})),
      } as never),
    ).toThrow(TypeError);
  });
});

describe('receiver.push', () => {
  it('verifies a SET and dispatches session-revoked', async () => {
    const seen: string[] = [];
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        aud: AUDIENCE,
        iat: 1_700_000_000,
        jti: 'set-1',
        sub_id: { format: 'iss_sub', iss: ISSUER, sub: 'user-1' },
        events: {
          [SESSION_REVOKED]: { event_timestamp: 1_700_000_100, sid: 'sess-1' },
        },
      })),
      subject: (setSubject) =>
        setSubject.format === 'iss_sub' ? String(setSubject.sub) : null,
      onEvent: {
        'session-revoked': ({ subject }) => {
          seen.push(`${subject.id}:${subject.session ?? ''}`);
        },
      },
    });
    const response = await receiver.push(setRequest('set-ok'));
    expect(response.status).toBe(202);
    expect(seen).toEqual(['user-1:sess-1']);
  });

  it('acknowledges a replayed jti without dispatching', async () => {
    let calls = 0;
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'replay-1',
        sub_id: { format: 'opaque', id: 'user-1' },
        events: { [SESSION_REVOKED]: {} },
      })),
      subject: () => 'user-1',
      onEvent: {
        'session-revoked': () => {
          calls += 1;
        },
      },
    });
    expect((await receiver.push(setRequest('set-a'))).status).toBe(202);
    expect((await receiver.push(setRequest('set-a'))).status).toBe(202);
    expect(calls).toBe(1);
  });

  it('acknowledges an unknown event unless onEvent * is set', async () => {
    const seen: string[] = [];
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'unk-1',
        sub_id: { format: 'email', email: 'a@example.com' },
        events: { [UNKNOWN_EVENT]: { reason: 'custom' } },
      })),
      subject: () => 'user-1',
      onEvent: {
        'session-revoked': () => {
          seen.push('revoked');
        },
      },
    });
    expect((await receiver.push(setRequest('set-unk'))).status).toBe(202);
    expect(seen).toEqual([]);

    const starred: string[] = [];
    const { receiver: other } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'unk-2',
        sub_id: { format: 'email', email: 'a@example.com' },
        events: { [UNKNOWN_EVENT]: { reason: 'custom' } },
      })),
      subject: () => 'user-1',
      onEvent: {
        '*': ({ type }) => {
          starred.push(type);
        },
      },
    });
    expect((await other.push(setRequest('set-star'))).status).toBe(202);
    expect(starred).toEqual([UNKNOWN_EVENT]);
  });

  it('acknowledges an unknown subject without error', async () => {
    const seen: string[] = [];
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'nosub-1',
        sub_id: { format: 'iss_sub', iss: ISSUER, sub: 'other' },
        events: { [CREDENTIAL_CHANGE]: {} },
      })),
      subject: () => null,
      onEvent: {
        'credential-change': () => {
          seen.push('hit');
        },
      },
    });
    expect((await receiver.push(setRequest('set-nosub'))).status).toBe(202);
    expect(seen).toEqual([]);
  });

  it('returns RFC 8935 invalid_key when verification fails', async () => {
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({})),
      subject: () => 'user-1',
    });
    const response = await receiver.push(setRequest('bad-sig'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      err: 'invalid_key',
      description: 'invalid-signature',
    });
  });

  it('returns 400 when a handler throws', async () => {
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      replay: memoryReplayStore(),
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'throw-1',
        sub: 'user-1',
        events: { [SESSION_REVOKED]: {} },
      })),
      subject: () => 'user-1',
      onEvent: {
        'session-revoked': () => {
          throw new Error('boom');
        },
      },
    });
    const response = await receiver.push(setRequest('set-throw'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ err: 'invalid_request' });
  });
});

describe('receiver.logout', () => {
  it('dispatches session-revoked joined on sid', async () => {
    const seen: Array<{ id: string; session?: string }> = [];
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'logout-1',
        sub: 'user-9',
        sid: 'sess-9',
        events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      })),
      subject: (setSubject, meta) => ({
        id: String(setSubject.sub ?? setSubject.id),
        session: meta?.session,
      }),
      onEvent: {
        'session-revoked': ({ subject }) => {
          seen.push({ id: subject.id, session: subject.session });
        },
      },
    });
    const response = await receiver.logout(logoutRequest('logout-ok'));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ id: 'user-9', session: 'sess-9' }]);
  });

  it('returns 400 invalid_request when nonce is present', async () => {
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'logout-nonce',
        sub: 'user-9',
        nonce: 'abc',
        events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      })),
      subject: () => 'user-9',
    });
    const response = await receiver.logout(logoutRequest('logout-nonce'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('returns 400 when typ is not logout+jwt', async () => {
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'set-as-logout',
        events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      })),
      subject: () => 'user-9',
    });
    const response = await receiver.logout(logoutRequest('set-not-logout'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('returns 400 when verification fails', async () => {
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({})),
      subject: () => 'user-9',
    });
    const response = await receiver.logout(logoutRequest('bad-logout'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });
});

describe('receiver.poll', () => {
  it('fetches SETs, dispatches, and acknowledges jtis', async () => {
    const seen: string[] = [];
    const fetches: unknown[] = [];
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'poll-1',
        sub_id: { format: 'opaque', id: 'user-2' },
        events: { [SESSION_REVOKED]: {} },
      })),
      subject: () => 'user-2',
      onEvent: {
        'session-revoked': ({ subject }) => {
          seen.push(subject.id);
        },
      },
    });
    const result = await receiver.poll({
      endpoint: 'https://login.example.com/ssf/poll',
      fetch: async (_url, init) => {
        fetches.push(JSON.parse(String(init?.body)));
        if (fetches.length === 1) {
          return new Response(
            JSON.stringify({ sets: { 'poll-1': 'set-poll' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ sets: {} }), { status: 200 });
      },
    });
    expect(result).toEqual({ acked: ['poll-1'] });
    expect(seen).toEqual(['user-2']);
    expect(fetches[1]).toMatchObject({ acks: ['poll-1'] });
  });

  it('retains a jti when the handler fails', async () => {
    const fetches: unknown[] = [];
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'poll-fail',
        sub_id: { format: 'opaque', id: 'user-2' },
        events: { [SESSION_REVOKED]: {} },
      })),
      subject: () => 'user-2',
      onEvent: {
        'session-revoked': () => {
          throw new Error('nope');
        },
      },
    });
    const result = await receiver.poll({
      endpoint: 'https://login.example.com/ssf/poll',
      fetch: async (_url, init) => {
        fetches.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ sets: { 'poll-fail': 'set-poll' } }),
          { status: 200 },
        );
      },
    });
    expect(result).toEqual({ acked: [] });
    expect(fetches).toHaveLength(1);
  });
});

describe('receiver.on', () => {
  it('emits audit events and is not a decision input', async () => {
    const events: string[] = [];
    const { receiver } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      verifier: verifier(() => ({
        iss: ISSUER,
        iat: 1,
        jti: 'audit-1',
        sub_id: { format: 'opaque', id: 'user-3' },
        events: { [SESSION_REVOKED]: {} },
      })),
      subject: () => 'user-3',
      onEvent: {
        'session-revoked': () => undefined,
      },
    });
    receiver.on('event', (event) => {
      events.push(event.type);
    });
    await receiver.push(setRequest('set-audit'));
    expect(events).toEqual(['session-revoked']);
  });
});
