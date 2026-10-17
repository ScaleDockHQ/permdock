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
 * Signs `snapshot` as a `vnd.permdock.snapshot+jwt`. `issuedAt` and
 * `expiresAt` become `iat` and `exp` and leave the `snapshot` claim, so the
 * registered claims are the only times a verifier reads.
 */
export function signSnapshot(
  snapshot: Snapshot,
  signer: TokenSigner,
  options: SignSnapshotOptions = {},
): Promise<string> {
  const { issuedAt, expiresAt, ...claim } = snapshot;
  const payload: Record<string, unknown> = { snapshot: claim };
  if (snapshot.subject.principal !== null) {
    payload["sub"] = snapshot.subject.principal.id;
  }
  const iat = secondsOf(issuedAt);
  return signer.sign(
    payload,
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: "vnd.permdock.snapshot+jwt" as const,
      audience: options.audience,
      issuedAt: iat === undefined || iat <= 0 ? undefined : iat,
      expiresAt: secondsOf(expiresAt),
    }),
  );
}

/**
 * The `snapshot` claim of verified claims with `issuedAt` and `expiresAt`
 * taken from `iat` and `exp`; `undefined` when the claim is not an object.
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
