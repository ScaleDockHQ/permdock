import { SignJWT, importJWK } from 'jose';
import { describe, expect, it } from 'vitest';

import { subjectFromIntrospection } from '../../src/jwt/introspection.ts';
import { createJwtSubjectResolver } from '../../src/jwt/subject.ts';
import { joseTokenVerifier } from '../../src/jwt/verifier.ts';

const PRIVATE_JWK = {
  crv: 'Ed25519',
  d: 'qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4',
  x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
  kty: 'OKP',
  kid: '2026-09',
  alg: 'Ed25519',
} as const;

const PUBLIC_JWKS = {
  keys: [
    {
      crv: 'Ed25519',
      x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
      kty: 'OKP',
      kid: '2026-09',
      alg: 'Ed25519',
    },
  ],
};

const ISSUER = 'https://login.example.com';
const AUDIENCE = 'https://api.example.com';

async function tokenFrom(issuer: string): Promise<string> {
  const key = await importJWK({ ...PRIVATE_JWK }, 'Ed25519');
  return new SignJWT({ sub: 'u_1' })
    .setProtectedHeader({ alg: 'Ed25519', kid: '2026-09', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

const discoveryFetch: typeof fetch = async (input) =>
  String(input).includes('openid-configuration')
    ? Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` })
    : Response.json(PUBLIC_JWKS);

describe('issuer binding', () => {
  it('requires issuer with a remote jwks URL', () => {
    for (const jwks of [`${ISSUER}/jwks`, new URL(`${ISSUER}/jwks`)]) {
      expect(() => createJwtSubjectResolver({ jwks })).toThrow(
        /issuer is required/,
      );
    }
  });

  it('takes the issuer from discovery when none is configured', async () => {
    const verifier = joseTokenVerifier({
      discovery: ISSUER,
      audience: AUDIENCE,
      fetch: discoveryFetch,
    });
    expect((await verifier.verify(await tokenFrom(ISSUER), {})).ok).toBe(true);
    expect(
      await verifier.verify(await tokenFrom('https://other.example.com'), {}),
    ).toMatchObject({ ok: false, cause: 'wrong-issuer' });
  });
});

describe('subjectFromIntrospection binding', () => {
  const base = { active: true, sub: 'u_1', iss: ISSUER, aud: AUDIENCE };

  it('requires the configured audience in aud', () => {
    const options = { audience: AUDIENCE };
    expect(subjectFromIntrospection(base, options).principal?.id).toBe('u_1');
    expect(
      subjectFromIntrospection(
        { ...base, aud: ['https://other.example.com', AUDIENCE] },
        options,
      ).principal?.id,
    ).toBe('u_1');
    expect(
      subjectFromIntrospection(
        { ...base, aud: 'https://other.example.com' },
        options,
      ).principal,
    ).toBeNull();
    const { aud: _aud, ...noAudience } = base;
    expect(subjectFromIntrospection(noAudience, options).principal).toBeNull();
  });

  it('rejects a different iss and never fills a missing one', () => {
    const options = { issuer: ISSUER };
    expect(
      subjectFromIntrospection(
        { ...base, iss: 'https://other.example.com' },
        options,
      ).principal,
    ).toBeNull();
    const { iss: _iss, ...noIssuer } = base;
    const subject = subjectFromIntrospection(noIssuer, options);
    expect(subject.principal?.id).toBe('u_1');
    expect(subject.principal?.issuer).toBeUndefined();
  });
});
