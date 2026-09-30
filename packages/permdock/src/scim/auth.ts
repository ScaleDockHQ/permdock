import type { TokenVerifier } from '../core/interfaces.ts';
import type { ScimTokenOptions } from './types.ts';

import { compact } from '../core/compact.ts';
import { sha256 } from '../core/sha256.ts';

export type ScimCredential =
  | { readonly kind: 'token' }
  | { readonly kind: 'jwt'; readonly iss?: string };

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0) {
    return undefined;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      return undefined;
    }
    out[index] = byte;
  }
  return out;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (header === null) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/iu.exec(header);
  return match?.[1];
}

async function matchStaticToken(
  tenant: string,
  token: string,
  options: ScimTokenOptions,
): Promise<boolean> {
  const stored = await options.lookup(tenant);
  const expected = hexToBytes(stored ?? '');
  const actual = sha256(token);
  if (expected === undefined) {
    timingSafeEqual(actual, actual);
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function tenantClaim(claims: Record<string, unknown>): string | undefined {
  if (typeof claims['tenant'] === 'string' && claims['tenant'] !== '') {
    return claims['tenant'];
  }
  if (typeof claims['tid'] === 'string' && claims['tid'] !== '') {
    return claims['tid'];
  }
  return undefined;
}

export type ScimAuthResult =
  | { readonly ok: true; readonly credential: ScimCredential }
  | { readonly ok: false; readonly status: 401 | 403 };

export async function authenticateScim(input: {
  readonly request: Request;
  readonly tenant: string;
  readonly audience: string;
  readonly token?: ScimTokenOptions;
  readonly verifier?: TokenVerifier;
}): Promise<ScimAuthResult> {
  const bearer = bearerToken(input.request);
  if (bearer === undefined) {
    return { ok: false, status: 401 };
  }
  if (input.token !== undefined) {
    const matched = await matchStaticToken(input.tenant, bearer, input.token);
    if (matched) {
      return { ok: true, credential: { kind: 'token' } };
    }
  }
  if (input.verifier === undefined) {
    return { ok: false, status: 401 };
  }
  const verified = await input.verifier.verify(bearer, {
    audience: input.audience,
  });
  if (!verified.ok) {
    return { ok: false, status: 401 };
  }
  const claimed = tenantClaim(verified.claims);
  if (claimed !== input.tenant) {
    return { ok: false, status: 403 };
  }
  return {
    ok: true,
    credential: compact<ScimCredential>({
      kind: 'jwt',
      iss:
        typeof verified.claims.iss === 'string'
          ? verified.claims.iss
          : undefined,
    }),
  };
}

export function sha256Hex(value: string): string {
  const bytes = sha256(value);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
