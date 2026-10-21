import type { JwtClaims, TokenSigner } from "./interfaces.ts";
import type { Snapshot } from "./snapshot-types.ts";

import { compact, isRecord } from "./compact.ts";
import { parseSnapshot } from "./snapshot.ts";
import { rfc3339, secondsOf } from "./time.ts";

export type SignSnapshotOptions = {
  /** `aud`; a signer with no default audience refuses to sign without one. */
  readonly audience?: string | readonly string[];
};

/**
 * The claims of a `vnd.permdock.snapshot+jwt` apart from `iss`, `aud` and
 * `jti`.
 */
export type SnapshotClaims = {
  readonly snapshot: Omit<Snapshot, "issuedAt" | "expiresAt">;
  /** The principal's id; absent for an anonymous snapshot. */
  readonly sub?: string;
  /** `issuedAt` in NumericDate seconds; absent when it is not after the epoch. */
  readonly iat?: number;
  /**
   * `expiresAt` in NumericDate seconds; absent when the snapshot has none, and
   * the signer then sets its default.
   */
  readonly exp?: number;
};

/**
 * The claims `signSnapshot` signs for `snapshot`. `issuedAt` and `expiresAt`
 * become `iat` and `exp` and leave the `snapshot` claim, so the registered
 * claims are the only times a verifier reads.
 */
export function snapshotClaims(snapshot: Snapshot): SnapshotClaims {
  const { issuedAt, expiresAt, ...claim } = snapshot;
  const iat = secondsOf(issuedAt);
  return compact<SnapshotClaims>({
    snapshot: claim,
    sub: snapshot.subject.principal?.id,
    iat: iat === undefined || iat <= 0 ? undefined : iat,
    exp: secondsOf(expiresAt),
  });
}

/**
 * Signs `snapshot` as a `vnd.permdock.snapshot+jwt` with the claims
 * `snapshotClaims` answers.
 */
export function signSnapshot(
  snapshot: Snapshot,
  signer: TokenSigner,
  options: SignSnapshotOptions = {},
): Promise<string> {
  const { iat, exp, ...payload } = snapshotClaims(snapshot);
  return signer.sign(
    payload,
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: "vnd.permdock.snapshot+jwt" as const,
      audience: options.audience,
      issuedAt: iat,
      expiresAt: exp,
    }),
  );
}

/**
 * The `snapshot` claim of verified claims with `issuedAt` and `expiresAt` taken
 * from `iat` and `exp`; `undefined` when the claim is not an object.
 */
export function snapshotClaim(claims: JwtClaims): unknown {
  const claim = claims["snapshot"];
  if (!isRecord(claim)) {
    return undefined;
  }
  const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...rest } = claim;
  return compact({
    ...rest,
    issuedAt: rfc3339(typeof claims.iat === "number" ? claims.iat : 0),
    expiresAt: typeof claims.exp === "number" ? rfc3339(claims.exp) : undefined,
  });
}

/**
 * The snapshot a verified `vnd.permdock.snapshot+jwt` carries, parsed as
 * `parseSnapshot` parses it, with `issuedAt` and `expiresAt` from `iat` and
 * `exp`. `null` when the claim is missing or not a valid snapshot.
 */
export function snapshotFromClaims(claims: JwtClaims): Snapshot | null {
  const claim = snapshotClaim(claims);
  if (claim === undefined) {
    return null;
  }
  try {
    return parseSnapshot(claim);
  } catch {
    return null;
  }
}
