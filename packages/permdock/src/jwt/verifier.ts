import type {
  JwtClaims,
  TokenVerifier,
  VerificationFailure,
  VerifiedToken,
} from '../core/interfaces.ts';
import type { JoseTokenVerifierOptions, JwtAlgorithm } from './types.ts';

import { compact } from '../core/compact.ts';
import { createKeyCache } from './cache.ts';
import {
  DEFAULT_DECRYPTION_ALGS,
  assertVerifierConfig,
  fail,
  isSecretJwks,
  resolveAlgorithms,
  resolveClockTolerance,
  secretBytes,
} from './config.ts';
import { decodeHeader, isJwe, normalizeTyp, unknownCrit } from './header.ts';
import { loadJose } from './load-jose.ts';

const ACCESS_TYPS: ReadonlySet<string> = new Set(['at+jwt', 'jwt']);
const FAPI2_TYPS: ReadonlySet<string> = new Set(['at+jwt']);

function algorithmAllowed(
  alg: string,
  allowed: readonly JwtAlgorithm[],
  key: Record<string, unknown> | undefined,
): boolean {
  if (alg === 'none') {
    return false;
  }
  if (alg === 'EdDSA') {
    return (
      allowed.includes('Ed25519') &&
      key?.['kty'] === 'OKP' &&
      key['crv'] === 'Ed25519'
    );
  }
  return allowed.includes(alg as JwtAlgorithm);
}

function findKey(
  keys: readonly Record<string, unknown>[],
  kid: string | undefined,
  profile: JoseTokenVerifierOptions['profile'],
): Record<string, unknown> | undefined {
  const usable = keys.filter((key) => !skipUndersized(key, profile));
  if (kid === undefined) {
    return usable.length === 1 ? usable[0] : undefined;
  }
  return usable.find((key) => key['kid'] === kid);
}

function skipUndersized(
  key: Record<string, unknown>,
  profile: JoseTokenVerifierOptions['profile'],
): boolean {
  if (profile !== 'fapi2') {
    return false;
  }
  if (key['kty'] === 'RSA' && typeof key['n'] === 'string') {
    const bits = Math.floor((key['n'].length * 6) / 8) * 8;
    return bits < 2048;
  }
  if (key['kty'] === 'EC' && key['crv'] === 'P-192') {
    return true;
  }
  return false;
}

function typAccepted(
  headerTyp: string | undefined,
  expected: string | readonly string[] | undefined,
  profile: JoseTokenVerifierOptions['profile'],
): boolean {
  const seen = normalizeTyp(headerTyp);
  if (expected !== undefined) {
    const list = typeof expected === 'string' ? [expected] : expected;
    return list.some((item) => normalizeTyp(item) === seen);
  }
  if (profile === 'fapi2') {
    return seen !== undefined && FAPI2_TYPS.has(seen.toLowerCase());
  }
  if (seen === undefined) {
    return true;
  }
  return ACCESS_TYPS.has(seen.toLowerCase());
}

function mapJoseCause(error: unknown): VerificationFailure['cause'] {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'invalid-signature';
  }
  const code = String((error as { readonly code: unknown }).code);
  if (code === 'ERR_JWT_EXPIRED') {
    return 'expired';
  }
  if (code === 'ERR_JWKS_NO_MATCHING_KEY') {
    return 'unknown-kid';
  }
  if (
    code === 'ERR_JOSE_ALG_NOT_ALLOWED' ||
    code === 'ERR_JWS_ALG_NOT_ALLOWED'
  ) {
    return 'alg-not-allowed';
  }
  if (code === 'ERR_JWE_INVALID' || code === 'ERR_JWE_NOT_SUPPORTED') {
    return 'encrypted-token';
  }
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    const claim = (error as { readonly claim?: string }).claim;
    if (claim === 'aud') {
      return 'wrong-audience';
    }
    if (claim === 'iss') {
      return 'wrong-issuer';
    }
    if (claim === 'nbf' || claim === 'iat') {
      return 'not-yet-valid';
    }
    if (claim === 'typ') {
      return 'wrong-token-type';
    }
    return 'malformed';
  }
  if (code === 'ERR_JWS_INVALID' || code === 'ERR_JWT_INVALID') {
    return 'malformed';
  }
  return 'invalid-signature';
}

export function joseTokenVerifier(
  options: JoseTokenVerifierOptions,
): TokenVerifier {
  assertVerifierConfig(options);
  const algorithms = resolveAlgorithms(options);
  const cache =
    options.jwks !== undefined && isSecretJwks(options.jwks)
      ? undefined
      : createKeyCache(options);
  const issuer = options.issuer;

  const verifyInner = async (
    token: string,
    expectations: Parameters<TokenVerifier['verify']>[1],
    keys: readonly Record<string, unknown>[] | Uint8Array,
    header: ReturnType<typeof decodeHeader>,
  ): Promise<VerifiedToken | VerificationFailure> => {
    const jose = await loadJose();
    const alg = header?.alg ?? '';
    const key =
      keys instanceof Uint8Array
        ? undefined
        : findKey(keys, header?.kid, options.profile);
    if (!(keys instanceof Uint8Array) && key === undefined) {
      return fail('unknown-kid');
    }
    if (!algorithmAllowed(alg, algorithms, key)) {
      return fail(alg === 'none' ? 'alg-none' : 'alg-not-allowed');
    }
    const expectedTyp = expectations.typ ?? options.typ;
    if (!typAccepted(header?.typ, expectedTyp, options.profile)) {
      return fail('wrong-token-type');
    }
    // RFC 8417 section 2.2: a SET may omit exp; it must carry iat instead.
    const securityEvent = normalizeTyp(header?.typ) === 'secevent+jwt';
    const verifyAlgs = algorithms.includes('Ed25519')
      ? [...algorithms, 'EdDSA']
      : [...algorithms];
    try {
      const getKey =
        keys instanceof Uint8Array
          ? keys
          : jose.createLocalJWKSet({ keys: keys as never });
      const result = await jose.jwtVerify(
        token,
        getKey,
        compact({
          algorithms: verifyAlgs,
          issuer: expectations.issuer ?? issuer,
          audience: expectations.audience ?? options.audience,
          clockTolerance: resolveClockTolerance(
            options,
            expectations.clockTolerance,
          ),
          requiredClaims: securityEvent ? ['iat'] : ['exp'],
        }),
      );
      const claims = result.payload as JwtClaims;
      if (!securityEvent && typeof claims.exp !== 'number') {
        return fail('expired');
      }
      return {
        ok: true,
        claims,
        header: compact({
          alg: String(result.protectedHeader.alg ?? alg),
          kid:
            typeof result.protectedHeader.kid === 'string'
              ? result.protectedHeader.kid
              : header?.kid,
          typ:
            typeof result.protectedHeader.typ === 'string'
              ? result.protectedHeader.typ
              : header?.typ,
        }),
      };
    } catch (error) {
      return fail(mapJoseCause(error));
    }
  };

  const decryptNested = async (
    token: string,
  ): Promise<
    { readonly ok: true; readonly jwt: string } | VerificationFailure
  > => {
    if (options.decryptionKeys === undefined) {
      return fail('encrypted-token');
    }
    const header = decodeHeader(token);
    if (
      header?.zip !== undefined ||
      header?.alg === 'RSA1_5' ||
      header?.cty === undefined ||
      normalizeTyp(header.cty) !== 'jwt'
    ) {
      return fail('encrypted-token');
    }
    const jose = await loadJose();
    try {
      const listed = options.decryptionKeys;
      const rawKeys: readonly Record<string, unknown>[] =
        'keys' in listed && Array.isArray(listed.keys)
          ? (listed.keys as readonly Record<string, unknown>[])
          : [listed];
      const first = rawKeys[0];
      if (
        first === undefined ||
        first['kty'] !== 'oct' ||
        typeof first['k'] !== 'string'
      ) {
        return fail('encrypted-token');
      }
      const { plaintext } = await jose.compactDecrypt(
        token,
        jose.base64url.decode(first['k']),
        {
          keyManagementAlgorithms: [
            ...(options.decryptionAlgorithms ?? DEFAULT_DECRYPTION_ALGS),
          ].filter((alg) => alg !== 'RSA1_5'),
        },
      );
      return { ok: true, jwt: new TextDecoder().decode(plaintext) };
    } catch {
      return fail('encrypted-token');
    }
  };

  return {
    verify(
      token: string,
      expectations: Parameters<TokenVerifier['verify']>[1] = {},
    ): Promise<VerifiedToken | VerificationFailure> {
      return verifyToken(token, expectations);
    },
  };

  async function verifyToken(
    token: string,
    expectations: Parameters<TokenVerifier['verify']>[1],
  ): Promise<VerifiedToken | VerificationFailure> {
    try {
      if (typeof token !== 'string' || token.length === 0) {
        return fail('malformed');
      }
      let jwt = token;
      if (isJwe(token)) {
        const decrypted = await decryptNested(token);
        if (!decrypted.ok) {
          return decrypted;
        }
        jwt = decrypted.jwt;
      }
      const header = decodeHeader(jwt);
      if (header === undefined) {
        return fail('malformed');
      }
      if (header.alg === 'none') {
        return fail('alg-none');
      }
      if (unknownCrit(header)) {
        return fail('malformed');
      }
      if (options.jwks !== undefined && isSecretJwks(options.jwks)) {
        const hsAllowed = algorithms.includes('HS256');
        if (!hsAllowed || header.alg !== 'HS256') {
          return fail(header.alg === 'none' ? 'alg-none' : 'alg-not-allowed');
        }
        return await verifyInner(
          jwt,
          expectations,
          secretBytes(options.jwks.secret),
          header,
        );
      }
      if (cache === undefined) {
        return fail('jwks-unavailable');
      }
      let resolved = await cache.resolveJwks();
      if (!resolved.ok) {
        return fail(resolved.cause);
      }
      let key = findKey(resolved.jwks.keys, header.kid, options.profile);
      if (key === undefined && header.kid !== undefined) {
        resolved = await cache.refetchJwks();
        if (!resolved.ok) {
          return fail(resolved.cause);
        }
        key = findKey(resolved.jwks.keys, header.kid, options.profile);
      }
      if (key === undefined) {
        return fail('unknown-kid');
      }
      return await verifyInner(jwt, expectations, resolved.jwks.keys, header);
    } catch {
      return fail('malformed');
    }
  }
}
