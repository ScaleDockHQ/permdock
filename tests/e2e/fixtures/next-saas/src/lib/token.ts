import type { Membership } from 'permdock';

import { SignJWT, createLocalJWKSet, importJWK, jwtVerify } from 'jose';

import type { SessionClaims } from '../policy.ts';

import { privateJwk, publicJwk } from './keys.ts';

export const SESSION_COOKIE = 'saas_session';
export const TOKEN_TTL_SECONDS = 3600;

const ISSUER = 'https://next-saas.test';
const AUDIENCE = 'next-saas';
const jwks = createLocalJWKSet({ keys: [publicJwk] });

function isMembership(value: unknown): value is Membership {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { tenant?: unknown; roles?: unknown };
  return (
    typeof record.tenant === 'string' &&
    Array.isArray(record.roles) &&
    record.roles.every((role) => typeof role === 'string')
  );
}

/** Local verification against a static JWKS: no network, never throws. */
export async function verifySession(
  token: string | undefined,
): Promise<SessionClaims | null> {
  if (token === undefined || token === '') {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['ES256'],
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.iat !== 'number'
    ) {
      return null;
    }
    const memberships = Array.isArray(payload.memberships)
      ? payload.memberships.filter((item) => isMembership(item))
      : undefined;
    return {
      sub: payload.sub,
      exp: payload.exp,
      iat: payload.iat,
      ...(memberships === undefined ? {} : { memberships }),
    };
  } catch {
    return null;
  }
}

export async function signSession(
  sub: string,
  memberships: readonly Membership[] | undefined,
): Promise<string> {
  const key = await importJWK(privateJwk, 'ES256');
  return new SignJWT(memberships === undefined ? {} : { memberships })
    .setProtectedHeader({ alg: 'ES256', kid: 'e2e', typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${String(TOKEN_TTL_SECONDS)}s`)
    .sign(key);
}
