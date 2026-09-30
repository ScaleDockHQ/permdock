import type { TokenSigner } from '../core/interfaces.ts';
import type { JsonWebKeyLike } from '../core/subject.ts';
import type { JoseTokenSignerOptions, JwtAlgorithm } from './types.ts';

import { loadJose } from './load-jose.ts';

const SIGNING_ALGS: ReadonlySet<JwtAlgorithm> = new Set([
  'ES256',
  'PS256',
  'Ed25519',
  'RS256',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicJwk(key: Record<string, unknown>): JsonWebKeyLike {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, k: _k, ...pub } = key;
  return pub;
}

export function joseTokenSigner(options: JoseTokenSignerOptions): TokenSigner {
  if (options.alg === 'HS256' || options.alg === 'EdDSA') {
    throw new Error(
      'PermDock: joseTokenSigner refuses HS* and polymorphic EdDSA on outputs.',
    );
  }
  if (!SIGNING_ALGS.has(options.alg)) {
    throw new Error(`PermDock: unsupported signing alg '${options.alg}'.`);
  }
  if (options.kid.length === 0) {
    throw new Error('PermDock: joseTokenSigner requires kid.');
  }

  const importKey = async (): Promise<Uint8Array | object> => {
    if (options.key instanceof Uint8Array) {
      throw new TypeError('PermDock: HMAC keys cannot sign PermDock outputs.');
    }
    const jose = await loadJose();
    // SAFETY: a non-Uint8Array key is the configured private JWK; importJWK validates it.
    return jose.importJWK(options.key as never, options.alg);
  };

  return {
    kid: options.kid,
    sign(
      payload: Readonly<Record<string, unknown>>,
      signOptions: Parameters<TokenSigner['sign']>[1],
    ): Promise<string> {
      return signJwt(payload, signOptions);
    },
    jwks(): Promise<{ readonly keys: readonly JsonWebKeyLike[] }> {
      if (isRecord(options.key)) {
        return Promise.resolve({ keys: [publicJwk(options.key)] });
      }
      return Promise.resolve({ keys: [] });
    },
  };

  async function signJwt(
    payload: Readonly<Record<string, unknown>>,
    signOptions: Parameters<TokenSigner['sign']>[1],
  ): Promise<string> {
    const jose = await loadJose();
    const key = await importKey();
    const now = Math.floor(Date.now() / 1000);
    const jwt = new jose.SignJWT({ ...payload });
    jwt.setProtectedHeader({
      alg: options.alg,
      kid: options.kid,
      typ: signOptions.typ,
    });
    jwt.setIssuedAt(now);
    jwt.setJti(globalThis.crypto.randomUUID());
    if (options.issuer !== undefined) {
      jwt.setIssuer(options.issuer);
    }
    if (signOptions.audience !== undefined) {
      // SAFETY: setAudience only reads the list, so a readonly array is not mutated.
      jwt.setAudience(signOptions.audience as string | string[]);
    }
    jwt.setExpirationTime(signOptions.expiresAt ?? now + 3600);
    return jwt.sign(key);
  }
}
