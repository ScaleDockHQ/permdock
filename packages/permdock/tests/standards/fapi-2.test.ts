import {
  SignJWT,
  base64url,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import type { JwtSubjectOptions } from '../../src/jwt/index.ts';

import { bytesToBase64Url, sha256 } from '../../src/core/sha256.ts';
import { verifyDpopProof } from '../../src/jwt/dpop.ts';
import {
  createJwtSubjectResolver,
  subjectFromJwt,
} from '../../src/jwt/subject.ts';

const ISSUER = 'https://as.bank.example';
const AUDIENCE = 'https://api.bank.example';
const RESOURCE_URL = 'https://api.bank.example/accounts';
const NOW = Math.floor(Date.now() / 1000);

type Keys = {
  readonly privateJwk: Record<string, unknown>;
  readonly publicJwk: Record<string, unknown>;
};

async function keys(alg: string, kid: string): Promise<Keys> {
  const pair = await generateKeyPair(alg, { extractable: true });
  return {
    privateJwk: { ...(await exportJWK(pair.privateKey)), kid },
    publicJwk: { ...(await exportJWK(pair.publicKey)), kid },
  };
}

let as: Keys;
let client: Keys;
let jkt: string;

beforeAll(async () => {
  as = await keys('ES256', 'as-1');
  client = await keys('ES256', 'client');
  jkt = await calculateJwkThumbprint(client.publicJwk);
});

async function accessToken(
  options: {
    readonly alg?: string;
    readonly signer?: Keys;
    readonly claims?: Record<string, unknown>;
    readonly typ?: string;
    readonly audience?: string;
  } = {},
): Promise<string> {
  const signer = options.signer ?? as;
  const alg = options.alg ?? 'ES256';
  return new SignJWT({
    sub: 'u_1',
    client_id: 'fintech',
    scope: 'accounts:read',
    cnf: { jkt },
    ...options.claims,
  })
    .setProtectedHeader({
      alg,
      kid: String(signer.privateJwk['kid']),
      typ: options.typ ?? 'at+jwt',
    })
    .setIssuer(ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(NOW)
    .setExpirationTime(NOW + 300)
    .sign(await importJWK(signer.privateJwk, alg));
}

async function proof(
  token: string,
  options: {
    readonly key?: Keys;
    readonly alg?: string;
    readonly jwk?: Record<string, unknown>;
    readonly htm?: string;
    readonly htu?: string;
    readonly iat?: number;
    readonly secret?: Uint8Array;
  } = {},
): Promise<string> {
  const key = options.key ?? client;
  const alg = options.alg ?? 'ES256';
  const { kid: _kid, ...jwk } = options.jwk ?? key.publicJwk;
  return new SignJWT({
    htm: options.htm ?? 'GET',
    htu: options.htu ?? RESOURCE_URL,
    jti: crypto.randomUUID(),
    ath: bytesToBase64Url(sha256(token)),
  })
    .setProtectedHeader({ alg, typ: 'dpop+jwt', jwk })
    .setIssuedAt(options.iat ?? NOW)
    .sign(options.secret ?? (await importJWK(key.privateJwk, alg)));
}

function request(dpop?: string, url = RESOURCE_URL): Request {
  return new Request(url, {
    headers: dpop === undefined ? {} : { DPoP: dpop },
  });
}

type Overrides = Partial<Omit<JwtSubjectOptions, 'profile'>> & {
  readonly profile?: JwtSubjectOptions['profile'] | 'none';
};

function fapi(causes: string[], overrides: Overrides = {}): JwtSubjectOptions {
  const { profile = 'fapi2', ...rest } = overrides;
  return {
    jwks: { keys: [as.publicJwk] },
    issuer: ISSUER,
    audience: AUDIENCE,
    ...(profile === 'none' ? {} : { profile }),
    sender: 'dpop',
    onAuth: (event) => {
      causes.push(String(event.cause));
    },
    ...rest,
  };
}

async function resolve(
  token: string,
  req: Request | undefined,
  overrides: Overrides = {},
): Promise<{ readonly id: string | undefined; readonly causes: string[] }> {
  const causes: string[] = [];
  const subject = await subjectFromJwt(token, fapi(causes, overrides), req);
  return { id: subject.principal?.id, causes };
}

describe('FAPI 2.0 Security Profile (Final) resource server, section 5.3.4', () => {
  it('item 5: a DPoP-bound token with a valid proof resolves the principal', async () => {
    const token = await accessToken();
    const result = await resolve(token, request(await proof(token)));
    expect(result).toEqual({ id: 'u_1', causes: [] });
  });

  it('item 5: a token without cnf is rejected as sender-constraint-required', async () => {
    const token = await accessToken({ claims: { cnf: undefined } });
    const result = await resolve(token, request(await proof(token)));
    expect(result.id).toBeUndefined();
    expect(result.causes).toEqual(['sender-constraint-required']);
  });

  it('item 5: a DPoP-bound token without its proof is rejected, with or without a request', async () => {
    const token = await accessToken();
    const missingHeader = await resolve(token, request());
    expect(missingHeader.id).toBeUndefined();
    expect(missingHeader.causes).toEqual(['dpop-proof-invalid']);
    const noRequest = await resolve(token, undefined);
    expect(noRequest.id).toBeUndefined();
    expect(noRequest.causes).toEqual(['dpop-proof-invalid']);
  });

  it('item 5: sender mtls compares cnf.x5t#S256 with the certificate thumbprint', async () => {
    const thumbprint = base64url.encode(sha256('client-cert'));
    const token = await accessToken({
      claims: { cnf: { 'x5t#S256': thumbprint } },
    });
    expect(
      await resolve(token, request(), {
        sender: 'mtls',
        certificateThumbprint: thumbprint,
      }),
    ).toEqual({ id: 'u_1', causes: [] });
    const other = await resolve(token, request(), {
      sender: 'mtls',
      certificateThumbprint: 'other',
    });
    expect(other.causes).toEqual(['mtls-binding-mismatch']);
  });

  it('item 5: the profile refuses sender none at configuration time', () => {
    expect(() =>
      createJwtSubjectResolver(fapi([], { sender: 'none' })),
    ).toThrow(/requires a sender constraint/u);
  });

  it('item 2: a token in the query string is rejected even when it verifies', async () => {
    const token = await accessToken();
    const result = await resolve(
      token,
      request(await proof(token), `${RESOURCE_URL}?access_token=${token}`),
    );
    expect(result.id).toBeUndefined();
    expect(result.causes).toEqual(['token-in-query']);
  });

  it('item 3: iss, aud and exp are checked', async () => {
    const wrongAudience = await accessToken({ audience: 'https://other' });
    expect(
      (await resolve(wrongAudience, request(await proof(wrongAudience))))
        .causes,
    ).toEqual(['wrong-audience']);
    const expired = await new SignJWT({ sub: 'u_1', cnf: { jkt } })
      .setProtectedHeader({ alg: 'ES256', kid: 'as-1', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(NOW - 600)
      .setExpirationTime(NOW - 300)
      .sign(await importJWK(as.privateJwk, 'ES256'));
    expect(
      (await resolve(expired, request(await proof(expired)))).causes,
    ).toEqual(['expired']);
  });

  it('the profile accepts only typ at+jwt', async () => {
    const token = await accessToken({ typ: 'JWT' });
    const result = await resolve(token, request(await proof(token)));
    expect(result.causes).toEqual(['wrong-token-type']);
  });
});

describe('FAPI 2.0 Security Profile (Final), section 5.4.1 algorithms', () => {
  it('PS256, ES256 and Ed25519 are accepted', async () => {
    for (const alg of ['PS256', 'ES256', 'Ed25519']) {
      const signer = await keys(alg, `as-${alg}`);
      const token = await accessToken({ alg, signer });
      const result = await resolve(token, request(await proof(token)), {
        jwks: { keys: [signer.publicJwk] },
      });
      expect({ alg, ...result }).toEqual({ alg, id: 'u_1', causes: [] });
    }
  });

  it('RS256 is refused under the profile and accepted without it', async () => {
    const signer = await keys('RS256', 'as-rs');
    const token = await accessToken({ alg: 'RS256', signer });
    const dpop = await proof(token);
    const strict = await resolve(token, request(dpop), {
      jwks: { keys: [signer.publicJwk] },
    });
    expect(strict.causes).toEqual(['alg-not-allowed']);
    const relaxed = await resolve(token, request(dpop), {
      jwks: { keys: [signer.publicJwk] },
      profile: 'none',
    });
    expect(relaxed).toEqual({ id: 'u_1', causes: [] });
  });
});

describe('RFC 9449 DPoP (September 2023), section 4.3 proof checks', () => {
  it('check 4: typ must be dpop+jwt', async () => {
    const token = await accessToken();
    const { kid: _kid, ...jwk } = client.publicJwk;
    const wrongTyp = await new SignJWT({
      htm: 'GET',
      htu: RESOURCE_URL,
      jti: 'j',
      ath: bytesToBase64Url(sha256(token)),
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', jwk })
      .setIssuedAt(NOW)
      .sign(await importJWK(client.privateJwk, 'ES256'));
    expect(
      await verifyDpopProof(request(wrongTyp), { cnf: { jkt } }, token),
    ).toEqual({ ok: false, cause: 'dpop-proof-invalid' });
  });

  it('check 5: a symmetric alg is refused even when its key matches cnf.jkt', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const jwk = { kty: 'oct', k: base64url.encode(secret) };
    const symmetricJkt = await calculateJwkThumbprint(jwk);
    const token = await accessToken({ claims: { cnf: { jkt: symmetricJkt } } });
    const hmac = await proof(token, { alg: 'HS256', jwk, secret });
    expect(
      await verifyDpopProof(
        request(hmac),
        { cnf: { jkt: symmetricJkt } },
        token,
      ),
    ).toEqual({ ok: false, cause: 'dpop-proof-invalid' });
  });

  it('check 7: a jwk header carrying the private key is refused', async () => {
    const token = await accessToken();
    const leaked = await proof(token, { jwk: client.privateJwk });
    expect(
      await verifyDpopProof(request(leaked), { cnf: { jkt } }, token),
    ).toEqual({ ok: false, cause: 'dpop-proof-invalid' });
  });

  it('checks 8 and 9: htm and htu must match the request', async () => {
    const token = await accessToken();
    for (const dpop of [
      await proof(token, { htm: 'POST' }),
      await proof(token, { htu: 'https://api.bank.example/other' }),
    ]) {
      expect(
        await verifyDpopProof(request(dpop), { cnf: { jkt } }, token),
      ).toEqual({ ok: false, cause: 'dpop-proof-invalid' });
    }
  });

  it('check 11: an iat outside the acceptance window is refused', async () => {
    const token = await accessToken();
    const stale = await proof(token, { iat: NOW - 3600 });
    expect(
      await verifyDpopProof(request(stale), { cnf: { jkt } }, token),
    ).toEqual({ ok: false, cause: 'dpop-proof-invalid' });
  });

  it('check 12: ath must hash the presented access token', async () => {
    const token = await accessToken();
    const other = await accessToken({ claims: { scope: 'payments:write' } });
    const dpop = await proof(token);
    expect(
      await verifyDpopProof(request(dpop), { cnf: { jkt } }, other),
    ).toEqual({
      ok: false,
      cause: 'dpop-proof-invalid',
    });
  });

  it('section 6.1: the proof key must match cnf.jkt', async () => {
    const token = await accessToken();
    const stranger = await keys('ES256', 'stranger');
    const dpop = await proof(token, { key: stranger });
    expect(
      await verifyDpopProof(request(dpop), { cnf: { jkt } }, token),
    ).toEqual({
      ok: false,
      cause: 'dpop-proof-invalid',
    });
  });
});
