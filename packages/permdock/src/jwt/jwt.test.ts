import {
  CompactEncrypt,
  SignJWT,
  UnsecuredJWT,
  base64url,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { memberUser, policy } from '../fixtures/quick-start.ts';
import { createPermDock } from '../index.ts';
import { verifyDpopProof } from './dpop.ts';
import { subjectFromIntrospection } from './introspection.ts';
import { joseTokenSigner } from './signer.ts';
import { createJwtSubjectResolver, subjectFromJwt } from './subject.ts';
import { joseTokenVerifier } from './verifier.ts';

const PRIVATE_JWK = {
  crv: 'Ed25519',
  d: 'qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4',
  x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
  kty: 'OKP',
  kid: '2026-09',
  alg: 'Ed25519',
  use: 'sig',
} as const;

const PUBLIC_JWKS = {
  keys: [
    {
      crv: 'Ed25519',
      x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
      kty: 'OKP',
      kid: '2026-09',
      alg: 'Ed25519',
      use: 'sig',
    },
  ],
};

const ISSUER = 'https://login.example.com';
const AUDIENCE = 'https://api.example.com';
const IAT = 1_700_000_000;
const EXP = 2_000_000_000;

async function accessToken(
  claims: Record<string, unknown> = {},
  header: Record<string, string> = {},
): Promise<string> {
  const key = await importJWK({ ...PRIVATE_JWK }, 'Ed25519');
  return new SignJWT({
    sub: 'u_1',
    client_id: 'app',
    roles: ['member'],
    ...claims,
  })
    .setProtectedHeader({
      alg: 'Ed25519',
      kid: '2026-09',
      typ: 'at+jwt',
      ...header,
    })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(IAT)
    .setExpirationTime(EXP)
    .sign(key);
}

function verifier() {
  return joseTokenVerifier({
    jwks: PUBLIC_JWKS,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['Ed25519'],
  });
}

describe('joseTokenSigner', () => {
  it('writes only alg, kid and typ and round-trips a snapshot', async () => {
    const signer = joseTokenSigner({
      key: { ...PRIVATE_JWK },
      alg: 'Ed25519',
      kid: '2026-09',
      issuer: 'https://app.example.com',
    });
    const jws = await signer.sign(
      { snapshot: { v: 2 }, sub: 'u_1' },
      { typ: 'permdock-snapshot+jwt', audience: 'https://app.example.com' },
    );
    const [encoded] = jws.split('.');
    expect(encoded).toBeDefined();
    const header = JSON.parse(
      atob(encoded!.replaceAll('-', '+').replaceAll('_', '/')),
    ) as Record<string, unknown>;
    expect(Object.keys(header).toSorted()).toEqual(['alg', 'kid', 'typ']);
    expect(header).toEqual({
      alg: 'Ed25519',
      kid: '2026-09',
      typ: 'permdock-snapshot+jwt',
    });
    const checked = await joseTokenVerifier({
      jwks: PUBLIC_JWKS,
      typ: 'permdock-snapshot+jwt',
    }).verify(jws, {
      typ: 'permdock-snapshot+jwt',
      audience: 'https://app.example.com',
      issuer: 'https://app.example.com',
    });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.claims.snapshot).toEqual({ v: 2 });
    }
    const published = await signer.jwks?.();
    expect(published?.keys[0]).toMatchObject({ kid: '2026-09', kty: 'OKP' });
    expect(published?.keys[0]).not.toHaveProperty('d');
  });
});

describe('joseTokenVerifier', () => {
  it('never throws and maps the behaviour table', async () => {
    const check = verifier();
    const valid = await accessToken();
    const ok = await check.verify(valid, {
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.claims.sub).toBe('u_1');
      expect(ok.header.alg).toBe('Ed25519');
      expect(ok.header.typ).toBe('at+jwt');
    }

    const none = new UnsecuredJWT({
      sub: 'u_1',
      iss: ISSUER,
      aud: AUDIENCE,
      exp: EXP,
      iat: IAT,
    }).encode();
    expect(await check.verify(none, { audience: AUDIENCE })).toMatchObject({
      ok: false,
      cause: 'alg-none',
    });

    const expired = await new SignJWT({ sub: 'u_1' })
      .setProtectedHeader({ alg: 'Ed25519', kid: '2026-09', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(1_000_000_000)
      .setExpirationTime(1_100_000_000)
      .sign(await importJWK({ ...PRIVATE_JWK }, 'Ed25519'));
    expect(await check.verify(expired, { audience: AUDIENCE })).toMatchObject({
      ok: false,
      cause: 'expired',
    });

    const wrongAud = await new SignJWT({ sub: 'u_1' })
      .setProtectedHeader({ alg: 'Ed25519', kid: '2026-09', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience('https://other.example.com')
      .setIssuedAt(IAT)
      .setExpirationTime(EXP)
      .sign(await importJWK({ ...PRIVATE_JWK }, 'Ed25519'));
    expect(await check.verify(wrongAud, { audience: AUDIENCE })).toMatchObject({
      ok: false,
      cause: 'wrong-audience',
    });

    const wrongIss = await new SignJWT({ sub: 'u_1' })
      .setProtectedHeader({ alg: 'Ed25519', kid: '2026-09', typ: 'at+jwt' })
      .setIssuer('https://evil.example.com')
      .setAudience(AUDIENCE)
      .setIssuedAt(IAT)
      .setExpirationTime(EXP)
      .sign(await importJWK({ ...PRIVATE_JWK }, 'Ed25519'));
    expect(await check.verify(wrongIss, { audience: AUDIENCE })).toMatchObject({
      ok: false,
      cause: 'wrong-issuer',
    });

    const unknownKid = await new SignJWT({ sub: 'u_1' })
      .setProtectedHeader({ alg: 'Ed25519', kid: 'nope', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(IAT)
      .setExpirationTime(EXP)
      .sign(await importJWK({ ...PRIVATE_JWK }, 'Ed25519'));
    expect(
      await check.verify(unknownKid, { audience: AUDIENCE }),
    ).toMatchObject({
      ok: false,
      cause: 'unknown-kid',
    });

    expect(
      await check.verify('not-a-jwt', { audience: AUDIENCE }),
    ).toMatchObject({
      ok: false,
      cause: 'malformed',
    });

    const jwe = 'a.b.c.d.e';
    expect(await check.verify(jwe, { audience: AUDIENCE })).toMatchObject({
      ok: false,
      cause: 'encrypted-token',
    });
  });

  it('accepts a nested JWE when decryptionKeys are set', async () => {
    const secret = new Uint8Array(32).fill(7);
    const inner = await accessToken();
    const jwe = await new CompactEncrypt(new TextEncoder().encode(inner))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', cty: 'JWT' })
      .encrypt(secret);
    const checked = await joseTokenVerifier({
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      decryptionKeys: {
        keys: [{ kty: 'oct', k: base64url.encode(secret), alg: 'dir' }],
      },
    }).verify(jwe, { audience: AUDIENCE });
    expect(checked.ok).toBe(true);
  });

  it('fetches discovery and JWKS over https', async () => {
    const token = await accessToken();
    const fetchImpl: typeof fetch = async (input) => {
      const href = String(input);
      if (href.includes('openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            jwks_uri: 'https://login.example.com/jwks',
          }),
          { headers: { 'cache-control': 'max-age=60' } },
        );
      }
      return new Response(JSON.stringify(PUBLIC_JWKS), {
        headers: { 'cache-control': 'max-age=60' },
      });
    };
    const checked = await joseTokenVerifier({
      discovery: ISSUER,
      audience: AUDIENCE,
      fetch: fetchImpl,
    }).verify(token, { audience: AUDIENCE });
    expect(checked.ok).toBe(true);
  });
});

describe('subjectFromJwt', () => {
  it('returns anonymous without an event when the token is missing', async () => {
    const events: unknown[] = [];
    const subject = await subjectFromJwt(undefined, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      onAuth: (event) => {
        events.push(event);
      },
    });
    expect(subject.principal).toBeNull();
    expect(events).toEqual([]);
  });

  it('maps RFC 9068 claims and never throws on invalid tokens', async () => {
    const events: { readonly cause?: string }[] = [];
    const token = await accessToken({
      roles: ['member'],
      groups: [{ value: '9f2c', display: 'Leads' }],
      entitlements: ['billing'],
      org_id: 'o_1',
      acr: 'urn:example:acr:2',
      amr: ['pwd'],
      auth_time: 1_700_000_100,
      sid: 'sess_1',
      scope: 'post:read post:update',
      act: { sub: 'agent-1' },
      cnf: { jkt: 'thumb' },
    });
    const subject = await subjectFromJwt(token, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      claims: { tenant: 'org_id' },
      groupRoles: { '9f2c': ['lead'] },
      sender: 'none',
    });
    expect(subject.principal?.id).toBe('u_1');
    expect(subject.principal?.issuer).toBe(ISSUER);
    expect(subject.principal?.roles).toEqual(['member']);
    expect(subject.principal?.plans).toEqual(['billing']);
    expect(subject.principal?.tenant).toBe('o_1');
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'o_1', team: '9f2c', roles: ['lead'], via: 'group:9f2c' },
    ]);
    expect(subject.principal?.assurance).toEqual({
      acr: 'urn:example:acr:2',
      amr: ['pwd'],
      authTime: 1_700_000_100,
    });
    expect(subject.session).toBe('sess_1');
    expect(subject.actor).toMatchObject({
      id: 'agent-1',
      kind: 'oauth-client',
    });
    expect(subject.actor?.binding).toEqual({ jkt: 'thumb' });
    expect(subject.delegation?.scopes).toEqual(['post:read', 'post:update']);

    const denied = await subjectFromJwt('nope', {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      onAuth: (event) => {
        events.push(event);
      },
    });
    expect(denied.principal).toBeNull();
    expect(events[0]?.cause).toBe('malformed');

    const resolver = createJwtSubjectResolver({
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      sender: 'none',
    });
    await expect(resolver(token)).resolves.toMatchObject({
      principal: { id: 'u_1' },
    });
  });

  it('drops custom claims when the schema fails and rejects unsafe paths', async () => {
    const token = await accessToken({ plan: 'pro' });
    const subject = await subjectFromJwt(token, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      sender: 'none',
      schema: z.object({ dept: z.string() }),
    });
    expect(subject.principal?.id).toBe('u_1');
    expect(subject.principal?.claims).toBeUndefined();
    expect(() =>
      createJwtSubjectResolver({
        jwks: PUBLIC_JWKS,
        issuer: ISSUER,
        claims: { id: '__proto__.id' },
      }),
    ).toThrow(/forbidden claim path/);
  });

  it('rejects fapi2 tokens without cnf and query-string tokens', async () => {
    const token = await accessToken();
    const events: string[] = [];
    const anonymous = await subjectFromJwt(
      token,
      {
        jwks: PUBLIC_JWKS,
        issuer: ISSUER,
        audience: AUDIENCE,
        profile: 'fapi2',
        sender: 'dpop',
        onAuth: (event) => {
          events.push(String(event.cause));
        },
      },
      new Request('https://api.example.com/x?access_token=stolen'),
    );
    expect(anonymous.principal).toBeNull();
    expect(events).toContain('token-in-query');
    const noCnf = await subjectFromJwt(token, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      profile: 'fapi2',
      sender: 'dpop',
      onAuth: (event) => {
        events.push(String(event.cause));
      },
    });
    expect(noCnf.principal).toBeNull();
    expect(events).toContain('sender-constraint-required');
  });
});

describe('verifyDpopProof', () => {
  it('accepts a matching proof and rejects a missing header', async () => {
    const { privateKey, publicKey } = await generateKeyPair('Ed25519', {
      extractable: true,
    });
    const jwk = await exportJWK(publicKey);
    const { calculateJwkThumbprint } = await import('jose');
    const jkt = await calculateJwkThumbprint(jwk, 'sha256');
    const request = new Request('https://api.example.com/posts', {
      method: 'PATCH',
    });
    const proof = await new SignJWT({
      htm: 'PATCH',
      htu: 'https://api.example.com/posts',
    })
      .setProtectedHeader({ alg: 'Ed25519', typ: 'dpop+jwt', jwk })
      .setIssuedAt()
      .setJti('dpop-1')
      .sign(privateKey);
    request.headers.set('DPoP', proof);
    const ok = await verifyDpopProof(request, { cnf: { jkt } });
    expect(ok).toEqual({ ok: true });
    const missing = await verifyDpopProof(
      new Request('https://api.example.com/posts', { method: 'PATCH' }),
      { cnf: { jkt } },
    );
    expect(missing).toEqual({ ok: false, cause: 'dpop-proof-invalid' });
    const wrongMethod = new Request('https://api.example.com/posts', {
      method: 'GET',
    });
    wrongMethod.headers.set('DPoP', proof);
    expect(await verifyDpopProof(wrongMethod, { cnf: { jkt } })).toEqual({
      ok: false,
      cause: 'dpop-proof-invalid',
    });
    expect(await verifyDpopProof(request, { cnf: { jkt: 'nope' } })).toEqual({
      ok: false,
      cause: 'dpop-proof-invalid',
    });
    const access = 'access.token.value';
    expect(await verifyDpopProof(request, { cnf: { jkt } }, access)).toEqual({
      ok: false,
      cause: 'dpop-proof-invalid',
    });
  });
});

describe('configuration and remaining causes', () => {
  it('rejects mutually exclusive or unsafe setup', () => {
    expect(() =>
      joseTokenVerifier({
        jwks: PUBLIC_JWKS,
        discovery: ISSUER,
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      joseTokenVerifier({
        discovery: 'http://login.example.com',
      }),
    ).toThrow(/https/);
    expect(() =>
      createJwtSubjectResolver({
        jwks: PUBLIC_JWKS,
        issuer: ISSUER,
        profile: 'fapi2',
        sender: 'none',
      }),
    ).toThrow(/sender constraint/);
    expect(() =>
      createJwtSubjectResolver({
        jwks: PUBLIC_JWKS,
      }),
    ).toThrow(/issuer is required/);
    expect(() =>
      joseTokenSigner({ key: { ...PRIVATE_JWK }, alg: 'HS256', kid: 'k' }),
    ).toThrow(/refuses/);
    expect(() =>
      joseTokenSigner({
        key: { ...PRIVATE_JWK },
        alg: 'Ed25519',
        kid: '',
      }),
    ).toThrow(/requires kid/);
    expect(() =>
      joseTokenVerifier({
        jwks: { secret: new Uint8Array(8) },
      }),
    ).toThrow(/256 bits/);
  });

  it('refuses HMAC material when signing outputs', async () => {
    await expect(
      joseTokenSigner({
        key: new Uint8Array(32),
        alg: 'Ed25519',
        kid: 'k',
      }).sign({ snapshot: {} }, { typ: 'permdock-snapshot+jwt' }),
    ).rejects.toThrow(/HMAC/);
  });

  it('verifies HS256 secrets and remote JWKS URLs', async () => {
    const secret = 'a'.repeat(32);
    const token = await new SignJWT({ sub: 'u_1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(IAT)
      .setExpirationTime(EXP)
      .sign(new TextEncoder().encode(secret));
    const hs = await joseTokenVerifier({
      jwks: { secret },
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }).verify(token, { audience: AUDIENCE });
    expect(hs.ok).toBe(true);

    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(PUBLIC_JWKS));
    const remote = await joseTokenVerifier({
      jwks: new URL('https://login.example.com/jwks'),
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchImpl,
    }).verify(await accessToken(), { audience: AUDIENCE });
    expect(remote.ok).toBe(true);

    const empty = await joseTokenVerifier({
      jwks: new URL('https://login.example.com/jwks'),
      issuer: ISSUER,
      fetch: async () => new Response(JSON.stringify({ keys: [] })),
    }).verify(await accessToken(), { audience: AUDIENCE });
    expect(empty).toMatchObject({ cause: 'jwks-unavailable' });

    let calls = 0;
    const rotating: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            keys: [{ ...PUBLIC_JWKS.keys[0], kid: 'standby' }],
          }),
        );
      }
      return new Response(JSON.stringify(PUBLIC_JWKS));
    };
    const unknownThenFound = await joseTokenVerifier({
      jwks: new URL('https://login.example.com/jwks'),
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: rotating,
      jwksCache: { cooldown: 0 },
    }).verify(await accessToken(), { audience: AUDIENCE });
    expect(unknownThenFound.ok).toBe(true);
  });

  it('maps discovery failures, crit headers and mTLS mismatches', async () => {
    const token = await accessToken();
    const mismatch = await joseTokenVerifier({
      discovery: ISSUER,
      fetch: async () =>
        new Response(JSON.stringify({ issuer: 'https://other.example.com' })),
    }).verify(token, { audience: AUDIENCE });
    expect(mismatch).toMatchObject({ cause: 'discovery-mismatch' });

    const down = await joseTokenVerifier({
      discovery: ISSUER,
      fetch: async () => {
        throw new Error('offline');
      },
    }).verify(token, { audience: AUDIENCE });
    expect(down).toMatchObject({ cause: 'discovery-unavailable' });

    const crit = await accessToken();
    const [h, p, s] = crit.split('.');
    const critHeader = {
      ...JSON.parse(atob(h!.replaceAll('-', '+').replaceAll('_', '/'))),
      crit: ['jku'],
      jku: 'https://evil.example.com',
    };
    const encoded = btoa(JSON.stringify(critHeader))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    expect(
      await verifier().verify(`${encoded}.${p}.${s}`, { audience: AUDIENCE }),
    ).toMatchObject({ cause: 'malformed' });

    const bound = await accessToken({ cnf: { 'x5t#S256': 'aa' } });
    const events: string[] = [];
    const mtls = await subjectFromJwt(bound, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      sender: 'mtls',
      certificateThumbprint: 'bb',
      onAuth: (event) => {
        events.push(String(event.cause));
      },
    });
    expect(mtls.principal).toBeNull();
    expect(events).toContain('mtls-binding-mismatch');

    const idToken = await new SignJWT({ sub: 'u_1', nonce: 'n' })
      .setProtectedHeader({ alg: 'Ed25519', kid: '2026-09', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(IAT)
      .setExpirationTime(EXP)
      .sign(await importJWK({ ...PRIVATE_JWK }, 'Ed25519'));
    const asAccess = await subjectFromJwt(idToken, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      accept: 'access-token',
      sender: 'none',
    });
    expect(asAccess.principal).toBeNull();
    const asId = await subjectFromJwt(idToken, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      accept: 'id-token',
      sender: 'none',
    });
    expect(asId.principal?.id).toBe('u_1');
    expect(asId.delegation).toBeUndefined();

    const noSub = await accessToken({ sub: undefined });
    const missing = await subjectFromJwt(noSub, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      sender: 'none',
    });
    expect(missing.principal).toBeNull();
  });

  it('merges memberships and workload kind literals', async () => {
    const token = await accessToken({
      tenants: { o_1: ['owner'] },
    });
    const subject = await subjectFromJwt(token, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      sender: 'none',
      claims: { kind: 'workload', memberships: 'tenants' },
      memberships: {
        membershipsFor: () => [{ tenant: 'o_2', roles: ['guest'] }],
      },
    });
    expect(subject.principal?.kind).toBe('workload');
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'o_1', roles: ['owner'] },
      { tenant: 'o_2', roles: ['guest'] },
    ]);
  });

  it('rejects a claimed act chain that does not nest', async () => {
    const events: { readonly cause?: string }[] = [];
    const token = await accessToken({ act: { iss: 'https://as.example' } });
    const subject = await subjectFromJwt(token, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      sender: 'none',
      onAuth: (event) => {
        events.push(event);
      },
    });
    expect(subject.principal).toBeNull();
    expect(events[0]?.cause).toBe('invalid-chain');
  });

  it('maps a nested act chain to the innermost actor', async () => {
    const token = await accessToken({
      act: { sub: 'edge', act: { sub: 'inner-agent' } },
    });
    const subject = await subjectFromJwt(token, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      sender: 'none',
    });
    expect(subject.actor).toMatchObject({
      id: 'inner-agent',
      kind: 'oauth-client',
    });
    expect(subject.delegation?.chain).toEqual({
      sub: 'edge',
      act: { sub: 'inner-agent' },
    });
  });

  it('maps JWT access onto delegation.access', async () => {
    const token = await accessToken({
      access: [{ type: 'post', actions: ['read'] }],
    });
    const subject = await subjectFromJwt(token, {
      jwks: PUBLIC_JWKS,
      issuer: ISSUER,
      audience: AUDIENCE,
      sender: 'none',
    });
    expect(subject.delegation?.access).toEqual([
      { type: 'post', actions: ['read'] },
    ]);
  });
});

describe('subjectFromIntrospection', () => {
  it('maps RFC 9767 active responses and never throws', () => {
    const subject = subjectFromIntrospection({
      active: true,
      sub: 'u_1',
      iss: ISSUER,
      instance_id: 'inst_9',
      access: [{ type: 'post', actions: ['read'] }],
      key: { proof: 'httpsig', jwk: { kty: 'OKP', crv: 'Ed25519' } },
    });
    expect(subject.principal?.id).toBe('u_1');
    expect(subject.principal?.issuer).toBe(ISSUER);
    expect(subject.actor).toMatchObject({
      id: 'inst_9',
      kind: 'oauth-client',
    });
    expect(subject.actor?.binding).toEqual({
      jwk: { kty: 'OKP', crv: 'Ed25519' },
    });
    expect(subject.delegation?.access).toEqual([
      { type: 'post', actions: ['read'] },
    ]);
    expect(
      subjectFromIntrospection({ active: false, sub: 'u_1' }).principal,
    ).toBeNull();
    expect(subjectFromIntrospection('nope').principal).toBeNull();
  });

  it('maps RFC 7662 scope and client_id', () => {
    const subject = subjectFromIntrospection({
      active: true,
      sub: 'u_1',
      iss: ISSUER,
      scope: 'post:read post:update',
      client_id: 'app',
    });
    expect(subject.delegation?.scopes).toEqual(['post:read', 'post:update']);
    expect(subject.actor).toEqual({ id: 'app', kind: 'oauth-client' });
  });
});

describe('signed snapshot', () => {
  it('lets createPermDock emit a JWS that joseTokenVerifier accepts', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const signer = joseTokenSigner({
      key: { ...PRIVATE_JWK },
      alg: 'Ed25519',
      kid: '2026-09',
      issuer: 'https://app.example.com',
    });
    const jws = await permdock.snapshot({
      signer,
      audience: 'https://app.example.com',
    });
    expect(typeof jws).toBe('string');
    const checked = await joseTokenVerifier({
      jwks: PUBLIC_JWKS,
      typ: 'permdock-snapshot+jwt',
    }).verify(jws as string, {
      typ: 'permdock-snapshot+jwt',
      audience: 'https://app.example.com',
      issuer: 'https://app.example.com',
    });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.claims.snapshot).toMatchObject({ v: 3 });
    }
  });
});
