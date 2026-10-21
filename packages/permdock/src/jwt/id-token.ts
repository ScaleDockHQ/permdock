import type {
  JwtClaims,
  TokenFailureCause,
  TokenVerifier,
  VerifiedToken,
} from "../core/interfaces.ts";
import type { JsonWebKeySet, JwtAlgorithm } from "./types.ts";

import { compact } from "../core/compact.ts";
import { idTokenMismatch } from "./map-claims.ts";
import { joseTokenVerifier } from "./verifier.ts";

/**
 * `TokenFailureCause` plus `nonce-mismatch`; a `TokenVerifier` never returns
 * it.
 */
export type IdTokenFailureCause = TokenFailureCause | "nonce-mismatch";

export type VerifyIdTokenOptions = {
  /** The OpenID Provider's issuer; `iss` must equal it. */
  readonly issuer: string;
  /**
   * The relying party's `client_id`; `aud` must contain it and `azp`, when
   * present, must equal it.
   */
  readonly clientId: string;
  /** The `nonce` sent in the authentication request; the token's must equal it. */
  readonly nonce?: string;
  readonly clockTolerance?: number;
} & (
  | {
      /** A verifier the caller keeps, so its JWKS cache outlives one call. */
      readonly verifier: TokenVerifier;
      readonly jwks?: never;
      readonly algorithms?: never;
    }
  | {
      readonly jwks: JsonWebKeySet;
      readonly algorithms?: readonly JwtAlgorithm[];
      readonly verifier?: never;
    }
);

export type IdTokenClaims = JwtClaims & {
  readonly iss: string;
  readonly sub: string;
  readonly iat: number;
};

export type VerifyIdTokenResult =
  | {
      readonly ok: true;
      readonly claims: IdTokenClaims;
      readonly header: VerifiedToken["header"];
    }
  | { readonly ok: false; readonly cause: IdTokenFailureCause };

/**
 * Verifies an OpenID Connect ID token for a relying party (Core section
 * 3.1.3.7): signature, `iss`, `aud`, `exp`, `iat`, `typ` `JWT` or absent, `azp`
 * and, when `nonce` is given, `nonce`. It does not check `at_hash`, `c_hash`,
 * `auth_time` or `acr`. Never throws.
 */
export async function verifyIdToken(
  token: string,
  options: VerifyIdTokenOptions,
): Promise<VerifyIdTokenResult> {
  const verifier =
    options.verifier ??
    joseTokenVerifier(
      compact({
        jwks: options.jwks,
        issuer: options.issuer,
        algorithms: options.algorithms,
      }),
    );
  let verified: Awaited<ReturnType<TokenVerifier["verify"]>>;
  try {
    verified = await verifier.verify(
      token,
      compact({
        issuer: options.issuer,
        audience: options.clientId,
        clockTolerance: options.clockTolerance,
      }),
    );
  } catch {
    return { ok: false, cause: "invalid-signature" };
  }
  if (!verified.ok) {
    return { ok: false, cause: verified.cause };
  }
  const { claims, header } = verified;
  if (idTokenMismatch(claims, header.typ, options.clientId)) {
    return { ok: false, cause: "wrong-token-type" };
  }
  const { iss, sub, iat } = claims;
  if (iss !== options.issuer) {
    return { ok: false, cause: "wrong-issuer" };
  }
  if (typeof sub !== "string" || sub === "" || typeof iat !== "number") {
    return { ok: false, cause: "malformed" };
  }
  if (options.nonce !== undefined && claims["nonce"] !== options.nonce) {
    return { ok: false, cause: "nonce-mismatch" };
  }
  return { ok: true, claims: { ...claims, iss, sub, iat }, header };
}
