import type { JwtClaims, TokenSigner } from "./interfaces.ts";
import type { Snapshot } from "./snapshot-types.ts";

import { compact, isRecord } from "./compact.ts";
import { rfc3339, secondsOf } from "./time.ts";

/**
 * Signs `snapshot` as a `vnd.permdock.snapshot+jwt`. `issuedAt` and
 * `expiresAt` become `iat` and `exp` and leave the `snapshot` claim, so the
 * registered claims are the only times a verifier reads.
 */
export function signSnapshot(
  snapshot: Snapshot,
  signer: TokenSigner,
  audience?: string | readonly string[],
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
      audience,
      issuedAt: iat === undefined || iat <= 0 ? undefined : iat,
      expiresAt: secondsOf(expiresAt),
    }),
  );
}

/**
 * The `snapshot` claim of verified claims with `issuedAt` and `expiresAt`
 * taken from `iat` and `exp`; `undefined` when the claim is not an object.
 */
export function snapshotFromClaims(claims: JwtClaims): unknown {
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
