import type { Membership } from '../../index.ts';

import { saasMemberships } from './seed.ts';

type EcJwk = {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: 'ES256';
  readonly use: 'sig';
};

// Test-only ES256 key pair. It signs fixture sessions and nothing else. Plain literals (no
// module-level calls) let bundlers drop it from clients that import only the definitions.
export const saasPublicJwk: EcJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'p5Q0wX-3-mOBqOcCTP-RHesn80ydMMNOpr_YNY6uE1I',
  y: 'Tr8Bo2w8QPJ1l0BfNLOEUsSz2VVJGx8AWMOika2yUeA',
  kid: 'e2e',
  alg: 'ES256',
  use: 'sig',
};

export const saasPrivateJwk: EcJwk & { readonly d: string } = {
  kty: 'EC',
  crv: 'P-256',
  x: 'p5Q0wX-3-mOBqOcCTP-RHesn80ydMMNOpr_YNY6uE1I',
  y: 'Tr8Bo2w8QPJ1l0BfNLOEUsSz2VVJGx8AWMOika2yUeA',
  kid: 'e2e',
  alg: 'ES256',
  use: 'sig',
  d: '8gTksJVtlkViFAL5tSmPaxnrR3QzONTODL6l8xDZiCk',
};

export const saasJwks: Readonly<{ keys: EcJwk[] }> = {
  keys: [saasPublicJwk],
};
export const saasIssuer = 'https://saas.permdock.test';
export const saasAudience = 'permdock-saas';
export const SAAS_TOKEN_TTL_SECONDS = 3600;

export type SaasTokenOptions = {
  /** Claim memberships; `false` omits the claim (database mode). Defaults to the seed. */
  readonly memberships?: readonly Membership[] | false;
  readonly ttl?: number;
  /** Epoch seconds used for `iat`. */
  readonly now?: number;
  readonly issuer?: string;
  readonly audience?: string;
  readonly claims?: Readonly<Record<string, unknown>>;
};

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Signs an ES256 access token for `sub` with WebCrypto; no dependency. */
export async function signSaasToken(
  sub: string,
  options: SaasTokenOptions = {},
): Promise<string> {
  const iat = options.now ?? Math.floor(Date.now() / 1000);
  const memberships =
    options.memberships === false
      ? undefined
      : (options.memberships ?? saasMemberships(sub));
  const header = { alg: 'ES256', kid: saasPublicJwk.kid, typ: 'at+jwt' };
  const payload = {
    ...options.claims,
    ...(memberships === undefined ? {} : { memberships }),
    iss: options.issuer ?? saasIssuer,
    aud: options.audience ?? saasAudience,
    sub,
    iat,
    exp: iat + (options.ttl ?? SAAS_TOKEN_TTL_SECONDS),
  };
  const input = `${encodeJson(header)}.${encodeJson(payload)}`;
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...saasPrivateJwk },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> {
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
}

function parseSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(decodeSegment(segment)),
    );
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verifies a token from `signSaasToken` (ES256, `kid`, `iss`, `aud`, `exp`)
 * and returns its `sub`, or `null`; never throws. Identity only: memberships
 * and plans come from the seed, never from the token.
 */
export async function verifySaasToken(
  token: string | null | undefined,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  return (await verifySaasSession(token, now))?.sub ?? null;
}

/** `verifySaasToken` plus the token's `exp` as `expiresAt` (epoch seconds). */
export async function verifySaasSession(
  token: string | null | undefined,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ readonly sub: string; readonly expiresAt: number } | null> {
  const parts = typeof token === 'string' ? token.split('.') : [];
  const [head, body, signature] = parts;
  if (
    parts.length !== 3 ||
    head === undefined ||
    body === undefined ||
    signature === undefined
  ) {
    return null;
  }
  const header = parseSegment(head);
  const payload = parseSegment(body);
  if (
    header?.['alg'] !== 'ES256' ||
    header['kid'] !== saasPublicJwk.kid ||
    payload === null
  ) {
    return null;
  }
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { ...saasPublicJwk },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      decodeSegment(signature),
      new TextEncoder().encode(`${head}.${body}`),
    );
    if (!valid) {
      return null;
    }
  } catch {
    return null;
  }
  const { sub, iss, aud, exp } = payload;
  if (
    typeof sub !== 'string' ||
    iss !== saasIssuer ||
    aud !== saasAudience ||
    typeof exp !== 'number' ||
    exp <= now
  ) {
    return null;
  }
  return { sub, expiresAt: exp };
}
