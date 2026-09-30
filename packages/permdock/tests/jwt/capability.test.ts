import { describe, expect, it } from 'vitest';

import type { AuthEvent } from '../../src/core/interfaces.ts';
import type { Subject } from '../../src/core/subject.ts';

import { signCapability } from '../../src/core/capability.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';
import { subjectFromCapability } from '../../src/jwt/capability.ts';
import { joseTokenSigner } from '../../src/jwt/signer.ts';
import { subjectFromJwt } from '../../src/jwt/subject.ts';
import { memoryReplayStore } from '../../src/ssf/replay.ts';

const PRIVATE_JWK = {
  crv: 'Ed25519',
  d: 'qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4',
  x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
  kty: 'OKP',
  kid: '2026-09',
  alg: 'Ed25519',
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;
const JWKS = { keys: [PUBLIC_JWK] };
const ISSUER = 'https://app.example.com';
const AUDIENCE = 'https://app.example.com';

const signer = joseTokenSigner({
  key: PRIVATE_JWK,
  alg: 'Ed25519',
  kid: '2026-09',
  issuer: ISSUER,
});

const permissions = definePermissions({
  quote: resource({ actions: ['read', 'accept'] }),
});

const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user,
    roles: [
      role(
        'guest',
        [allow(permissions.quote.read), allow(permissions.quote.accept)],
        { on: permissions.quote },
      ),
    ],
  },
);

const inAnHour = (): number => Math.floor(Date.now() / 1000) + 3600;

function link(
  extra: Partial<Parameters<typeof signCapability>[0]> = {},
  audience: string = AUDIENCE,
): Promise<string> {
  return signCapability(
    {
      id: 'lnk_1',
      on: { resource: permissions.quote, id: 'q_1' },
      roles: ['guest'],
      expiresAt: inAnHour(),
      ...extra,
    },
    signer,
    { audience },
  );
}

function resolve(
  token: string,
  extra: Partial<Parameters<typeof subjectFromCapability>[1]> = {},
): Promise<{ subject: Subject; events: AuthEvent[] }> {
  const events: AuthEvent[] = [];
  return subjectFromCapability(token, {
    jwks: JWKS,
    issuer: ISSUER,
    audience: AUDIENCE,
    onAuth: (event) => {
      events.push(event);
    },
    ...extra,
  }).then((subject) => ({ subject, events }));
}

function can(subject: Subject, id: string): boolean {
  const dock = createPermDock(policy, subject);
  if (dock instanceof Promise) {
    throw new TypeError('expected a synchronous instance');
  }
  return dock.can(permissions.quote.read, { id });
}

describe('subjectFromCapability', () => {
  it('resolves a signed link into a link principal on its resource', async () => {
    const { subject, events } = await resolve(await link());
    expect(events).toEqual([]);
    expect(subject.principal).toMatchObject({
      id: 'lnk_1',
      kind: 'link',
      issuer: ISSUER,
      memberships: [
        { on: { resource: 'quote', id: 'q_1' }, roles: ['guest'], via: 'link' },
      ],
    });
    expect(can(subject, 'q_1')).toBe(true);
    expect(can(subject, 'q_2')).toBe(false);
  });

  it('is anonymous for a missing token', async () => {
    const { subject, events } = await resolve('');
    expect(subject.principal).toBeNull();
    expect(events).toEqual([]);
  });

  it('refuses a token signed for another audience', async () => {
    const { subject, events } = await resolve(
      await link({}, 'https://other.example.com'),
    );
    expect(subject.principal).toBeNull();
    expect(events[0]).toMatchObject({
      reason: 'invalid-token',
      cause: 'wrong-audience',
      source: 'capability',
    });
  });

  it('refuses another PermDock output carrying a capability claim', async () => {
    const token = await signer.sign(
      {
        sub: 'lnk_1',
        capability: {
          v: 1,
          id: 'lnk_1',
          holder: 'link',
          on: { resource: 'quote', id: 'q_1' },
          roles: ['guest'],
          expiresAt: inAnHour(),
        },
      },
      { typ: 'permdock-snapshot+jwt', audience: AUDIENCE },
    );
    const { subject, events } = await resolve(token);
    expect(subject.principal).toBeNull();
    expect(events[0]?.cause).toBe('wrong-token-type');
  });

  it('is never accepted as an access token', async () => {
    const events: AuthEvent[] = [];
    const subject = await subjectFromJwt(await link(), {
      jwks: JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      onAuth: (event) => {
        events.push(event);
      },
    });
    expect(subject.principal).toBeNull();
    expect(events[0]?.cause).toBe('wrong-token-type');
  });

  it('refuses an expired link', async () => {
    const { subject, events } = await resolve(
      await link({ expiresAt: Math.floor(Date.now() / 1000) - 60 }),
    );
    expect(subject.principal).toBeNull();
    expect(events[0]?.cause).toBe('expired');
  });

  it('refuses a link whose sub is not its id', async () => {
    const token = await signer.sign(
      {
        sub: 'lnk_other',
        capability: {
          v: 1,
          id: 'lnk_1',
          holder: 'link',
          on: { resource: 'quote', id: 'q_1' },
          roles: ['guest'],
          expiresAt: inAnHour(),
        },
      },
      { typ: 'permdock-capability+jwt', audience: AUDIENCE },
    );
    const { subject, events } = await resolve(token);
    expect(subject.principal).toBeNull();
    expect(events[0]?.cause).toBe('invalid-claims');
  });

  it('refuses a reserved key holder', async () => {
    const token = await signer.sign(
      {
        sub: 'key_1',
        capability: {
          v: 1,
          id: 'key_1',
          holder: 'key',
          on: { resource: 'quote', id: 'q_1' },
          roles: ['guest'],
          expiresAt: inAnHour(),
        },
      },
      { typ: 'permdock-capability+jwt', audience: AUDIENCE },
    );
    const { subject, events } = await resolve(token);
    expect(subject.principal).toBeNull();
    expect(events[0]?.cause).toBe('invalid-claims');
  });

  it('refuses a revoked link id and fails closed when revocation throws', async () => {
    const token = await link();
    const revoked = await resolve(token, {
      revoked: (id) => Promise.resolve(id === 'lnk_1'),
    });
    expect(revoked.subject.principal).toBeNull();
    expect(revoked.events[0]?.cause).toBe('capability-revoked');
    const broken = await resolve(token, {
      revoked: () => {
        throw new Error('db down');
      },
    });
    expect(broken.subject.principal).toBeNull();
    expect(broken.events[0]).toMatchObject({
      reason: 'source-threw',
      source: 'capability',
    });
  });

  it('redeems a one-time link once', async () => {
    const token = await link({ once: true });
    const replay = memoryReplayStore();
    const first = await resolve(token, { replay });
    expect(first.subject.principal?.id).toBe('lnk_1');
    const second = await resolve(token, { replay });
    expect(second.subject.principal).toBeNull();
    expect(second.events[0]?.cause).toBe('capability-replayed');
    const other = await resolve(await link({ once: true }), { replay });
    expect(other.subject.principal?.id).toBe('lnk_1');
  });

  it('refuses a one-time link without a replay store', async () => {
    const { subject, events } = await resolve(await link({ once: true }));
    expect(subject.principal).toBeNull();
    expect(events[0]?.cause).toBe('invalid-claims');
  });

  it('does not burn a one-time link the viewer may not redeem', async () => {
    const token = await link({ once: true, redeemer: { user: 'u_1' } });
    const replay = memoryReplayStore();
    const stranger = await resolve(token, { replay });
    expect(stranger.events[0]?.cause).toBe('redeemer-mismatch');
    const owner = await resolve(token, {
      replay,
      viewer: { principal: { id: 'u_1', roles: [] }, context: {} },
    });
    expect(owner.subject.principal?.id).toBe('lnk_1');
  });

  it('checks the redeemer against the viewer', async () => {
    const token = await link({ redeemer: 'signed-in' });
    const anonymous = await resolve(token);
    expect(anonymous.subject.principal).toBeNull();
    expect(anonymous.events[0]?.cause).toBe('redeemer-mismatch');
    const signedIn = await resolve(token, {
      viewer: { principal: { id: 'u_9', roles: [] }, context: {} },
    });
    expect(signedIn.subject.principal?.kind).toBe('link');
  });

  it("refuses a link the linked scope's policy forbids", async () => {
    const token = await link();
    const seen: string[] = [];
    const strict = await resolve(token, {
      linkPolicy: (capability) => {
        seen.push(capability.on.id);
        return [{ maxLifetime: 30 * 86_400 }, { once: true }];
      },
    });
    expect(seen).toEqual(['q_1']);
    expect(strict.subject.principal).toBeNull();
    expect(strict.events[0]?.cause).toBe('link-policy');
    const short = await resolve(token, {
      linkPolicy: () => Promise.resolve({ maxLifetime: 60 }),
    });
    expect(short.events[0]?.cause).toBe('link-policy');
    const allowed = await resolve(token, {
      linkPolicy: () => ({ maxLifetime: 2 * 3600, redeemers: ['anyone'] }),
    });
    expect(allowed.subject.principal?.id).toBe('lnk_1');
    const none = await resolve(token, { linkPolicy: () => undefined });
    expect(none.subject.principal?.id).toBe('lnk_1');
  });

  it('fails closed when the link policy lookup throws', async () => {
    const { subject, events } = await resolve(await link(), {
      linkPolicy: () => Promise.reject(new Error('db down')),
    });
    expect(subject.principal).toBeNull();
    expect(events[0]).toMatchObject({ reason: 'source-threw' });
  });

  it('does not burn a one-time link its policy refuses', async () => {
    const token = await link({ once: true });
    const replay = memoryReplayStore();
    const refused = await resolve(token, {
      replay,
      linkPolicy: () => ({ redeemers: ['signed-in'] }),
    });
    expect(refused.events[0]?.cause).toBe('link-policy');
    const later = await resolve(token, { replay });
    expect(later.subject.principal?.id).toBe('lnk_1');
  });

  it('is anonymous when issuer or audience is missing', async () => {
    const token = await link();
    const noIssuer = await resolve(token, { issuer: '' });
    expect(noIssuer.events[0]?.cause).toBe('wrong-issuer');
    const noAudience = await resolve(token, { audience: [] });
    expect(noAudience.events[0]?.cause).toBe('wrong-audience');
  });
});
