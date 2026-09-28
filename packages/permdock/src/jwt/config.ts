import type { TokenFailureCause } from '../core/interfaces.ts';
import type {
  DiscoveryInput,
  JoseTokenVerifierOptions,
  JwtAlgorithm,
  JwtClaimPaths,
  JwtJwks,
  JwtSubjectOptions,
} from './types.ts';

import { isForbiddenKey, splitPath } from '../core/paths.ts';

export const DEFAULT_ALGORITHMS: readonly JwtAlgorithm[] = [
  'ES256',
  'PS256',
  'Ed25519',
  'RS256',
];

export const FAPI2_ALGORITHMS: readonly JwtAlgorithm[] = [
  'ES256',
  'PS256',
  'Ed25519',
];

export const DEFAULT_DECRYPTION_ALGS: readonly string[] = [
  'RSA-OAEP-256',
  'ECDH-ES',
  'ECDH-ES+A256KW',
  'dir',
];

export const DEFAULT_CLOCK_TOLERANCE = 5;
export const FAPI2_CLOCK_TOLERANCE = 5;
export const DEFAULT_JWKS_MIN_TTL = 60;
export const DEFAULT_JWKS_MAX_TTL = 3600;
export const DEFAULT_JWKS_COOLDOWN = 60;

export function fail(cause: TokenFailureCause): {
  readonly ok: false;
  readonly reason: 'invalid-token';
  readonly cause: TokenFailureCause;
} {
  return { ok: false, reason: 'invalid-token', cause };
}

export function isSecretJwks(
  jwks: JwtJwks,
): jwks is { readonly secret: Uint8Array | string } {
  return (
    typeof jwks === 'object' &&
    jwks !== null &&
    !(jwks instanceof URL) &&
    'secret' in jwks
  );
}

export function isKeySet(
  jwks: JwtJwks,
): jwks is { readonly keys: readonly Record<string, unknown>[] } {
  return (
    typeof jwks === 'object' &&
    jwks !== null &&
    !(jwks instanceof URL) &&
    'keys' in jwks &&
    Array.isArray(jwks.keys)
  );
}

export function issuerFromDiscovery(discovery: DiscoveryInput): string {
  return typeof discovery === 'string' ? discovery : discovery.issuer;
}

export function resolveAlgorithms(
  options: JoseTokenVerifierOptions,
): readonly JwtAlgorithm[] {
  if (options.algorithms !== undefined) {
    return options.algorithms;
  }
  return options.profile === 'fapi2' ? FAPI2_ALGORITHMS : DEFAULT_ALGORITHMS;
}

export function resolveClockTolerance(
  options: JoseTokenVerifierOptions,
  override?: number,
): number {
  const configured =
    override ?? options.clockTolerance ?? DEFAULT_CLOCK_TOLERANCE;
  if (options.profile === 'fapi2') {
    return Math.min(configured, FAPI2_CLOCK_TOLERANCE);
  }
  return configured;
}

export function assertSafeClaimPaths(claims: JwtClaimPaths | undefined): void {
  if (claims === undefined) {
    return;
  }
  const paths: string[] = [
    claims.id,
    claims.roles,
    claims.groups,
    claims.entitlements,
    claims.tenant,
    claims.memberships,
    claims.session,
  ].filter((path): path is string => path !== undefined);
  if (typeof claims.assurance === 'string') {
    paths.push(claims.assurance);
  } else if (claims.assurance !== undefined) {
    paths.push(
      ...[
        claims.assurance.acr,
        claims.assurance.amr,
        claims.assurance.authTime,
        claims.assurance.verified,
      ].filter((path): path is string => path !== undefined),
    );
  }
  if (
    claims.kind !== undefined &&
    claims.kind !== 'workload' &&
    claims.kind !== 'user' &&
    claims.kind !== 'service'
  ) {
    paths.push(claims.kind);
  }
  for (const path of paths) {
    for (const segment of splitPath(path)) {
      if (isForbiddenKey(segment)) {
        throw new Error(`PermDock: forbidden claim path '${path}'.`);
      }
    }
  }
}

export function assertVerifierConfig(options: JoseTokenVerifierOptions): void {
  if (options.discovery !== undefined && options.jwks !== undefined) {
    throw new Error('PermDock: discovery and jwks are mutually exclusive.');
  }
  if (options.discovery === undefined && options.jwks === undefined) {
    throw new Error('PermDock: joseTokenVerifier requires jwks or discovery.');
  }
  if (typeof options.jwks === 'string' && !URL.canParse(options.jwks)) {
    throw new Error('PermDock: jwks must be an absolute URL.');
  }
  if (options.discovery !== undefined) {
    const issuer = issuerFromDiscovery(options.discovery);
    let url: URL;
    try {
      url = new URL(issuer);
    } catch {
      throw new Error('PermDock: discovery issuer must be an absolute URL.');
    }
    if (url.protocol !== 'https:') {
      throw new Error('PermDock: discovery issuer must use https.');
    }
    if (options.issuer !== undefined && options.issuer !== issuer) {
      throw new Error('PermDock: issuer must match discovery or be omitted.');
    }
  }
  if (options.jwks !== undefined && isSecretJwks(options.jwks)) {
    const bits = secretBits(options.jwks.secret);
    if (bits < 256) {
      throw new Error('PermDock: HMAC secret must be at least 256 bits.');
    }
  }
  const algorithms = resolveAlgorithms(options);
  if (algorithms.includes('none' as JwtAlgorithm)) {
    throw new Error('PermDock: alg none is never accepted.');
  }
}

export function assertSubjectConfig(options: JwtSubjectOptions): void {
  if (options.verifier === undefined) {
    assertVerifierConfig(options);
    if (
      options.jwks !== undefined &&
      isKeySet(options.jwks) &&
      options.issuer === undefined
    ) {
      throw new Error('PermDock: issuer is required with jwks.');
    }
  }
  assertSafeClaimPaths(options.claims);
  if (options.profile === 'fapi2' && options.sender === 'none') {
    throw new Error("PermDock: profile 'fapi2' requires a sender constraint.");
  }
}

export function secretBits(secret: Uint8Array | string): number {
  if (typeof secret === 'string') {
    return secret.length * 8;
  }
  return secret.byteLength * 8;
}

export function secretBytes(secret: Uint8Array | string): Uint8Array {
  if (typeof secret === 'string') {
    return new TextEncoder().encode(secret);
  }
  return secret;
}
