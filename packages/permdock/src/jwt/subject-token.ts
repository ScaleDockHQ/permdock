import type {
  JwtClaims,
  TokenFailureCause,
  TokenVerifier,
  VerifiedToken,
} from "../core/interfaces.ts";
import type { ReplayStore } from "../ssf/types.ts";

import { normalizeTyp } from "./header.ts";

/**
 * `TokenFailureCause` plus the two checks `verifySubjectToken` adds; a
 * `TokenVerifier` never returns them.
 */
export type SubjectTokenFailureCause =
  | TokenFailureCause
  | "replayed"
  | "lifetime-exceeded";

export type VerifySubjectTokenOptions = {
  /** Tried in order; the first that accepts the token wins. */
  readonly verifiers: readonly TokenVerifier[];
  readonly audience: string | readonly string[];
  /**
   * Records each `jti` once; `claim` when the store has it, else `seen` and
   * `remember`.
   */
  readonly replay: ReplayStore;
  /** The largest `exp - iat`, in seconds; default 300. */
  readonly maxLifetime?: number;
  readonly clockTolerance?: number;
};

export type SubjectTokenClaims = JwtClaims & {
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
};

export type VerifySubjectTokenResult =
  | {
      readonly ok: true;
      readonly claims: SubjectTokenClaims;
      readonly header: VerifiedToken["header"];
    }
  | { readonly ok: false; readonly cause: SubjectTokenFailureCause };

const DEFAULT_MAX_LIFETIME = 300;
/**
 * Causes a verifier for another issuer answers; a different cause names the
 * token's real fault.
 */
const OTHER_ISSUER: ReadonlySet<TokenFailureCause> = new Set([
  "wrong-issuer",
  "unknown-kid",
]);

async function firstAccepted(
  token: string,
  options: VerifySubjectTokenOptions,
): Promise<VerifiedToken | { readonly cause: TokenFailureCause }> {
  const causes: TokenFailureCause[] = [];
  for (const verifier of options.verifiers) {
    let verified: Awaited<ReturnType<TokenVerifier["verify"]>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- verifiers are tried in order; the first that accepts wins
      verified = await verifier.verify(token, {
        typ: "at+jwt",
        audience: options.audience,
        ...(options.clockTolerance === undefined
          ? {}
          : { clockTolerance: options.clockTolerance }),
      });
    } catch {
      causes.push("invalid-signature");
      continue;
    }
    if (verified.ok) {
      return verified;
    }
    causes.push(verified.cause);
  }
  return {
    cause:
      causes.find((cause) => !OTHER_ISSUER.has(cause)) ??
      causes[0] ??
      "invalid-signature",
  };
}

async function claimOnce(
  replay: ReplayStore,
  key: string,
  expiresAt: number,
): Promise<boolean> {
  try {
    if (replay.claim !== undefined) {
      return await replay.claim(key, expiresAt);
    }
    if (await replay.seen(key)) {
      return false;
    }
    await replay.remember(key, expiresAt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies a subject token: an RFC 9068 `at+jwt` naming one subject for one
 * request, such as the `PermDock-Subject` header. The first of `verifiers` that
 * accepts it wins. The token must carry `sub`, `jti`, `iat` and `exp`, live at
 * most `maxLifetime` seconds, and present its `jti` once. A replay store that
 * throws refuses the token as `replayed`. Never throws.
 */
export async function verifySubjectToken(
  token: string,
  options: VerifySubjectTokenOptions,
): Promise<VerifySubjectTokenResult> {
  const verified = await firstAccepted(token, options);
  if (!("ok" in verified)) {
    return { ok: false, cause: verified.cause };
  }
  if (normalizeTyp(verified.header.typ)?.toLowerCase() !== "at+jwt") {
    return { ok: false, cause: "wrong-token-type" };
  }
  const { claims } = verified;
  const { sub, jti, iat, exp } = claims;
  if (
    typeof sub !== "string" ||
    sub === "" ||
    typeof jti !== "string" ||
    jti === "" ||
    typeof iat !== "number" ||
    typeof exp !== "number"
  ) {
    return { ok: false, cause: "malformed" };
  }
  if (exp - iat > (options.maxLifetime ?? DEFAULT_MAX_LIFETIME)) {
    return { ok: false, cause: "lifetime-exceeded" };
  }
  const key = `subject-token\n${claims.iss ?? ""}\n${jti}`;
  if (
    !(await claimOnce(options.replay, key, exp + (options.clockTolerance ?? 0)))
  ) {
    return { ok: false, cause: "replayed" };
  }
  return {
    ok: true,
    claims: { ...claims, sub, jti, iat, exp },
    header: verified.header,
  };
}
