import { readPath } from "./paths.ts";

/** Where a value lives in verified claims: a dotted path (`app_metadata.roles`), or a function over the claims. */
export type ClaimPath =
  | string
  | ((claims: Readonly<Record<string, unknown>>) => unknown);

/**
 * How one provider's verified claims map to a principal. Every subject
 * provider takes it as `claims`; each field it leaves out keeps that
 * provider's default. Mapping only: core never verifies a token, and a claim
 * becomes a principal field only after the provider verified the token.
 */
export type ClaimsMap = {
  readonly id?: ClaimPath;
  readonly roles?: ClaimPath;
  readonly groups?: ClaimPath;
  readonly entitlements?: ClaimPath;
  readonly plans?: ClaimPath;
  /** The active tenant. */
  readonly tenant?: ClaimPath;
  /** `[{ scope, id, within?, roles }]` carried in the token. */
  readonly memberships?: ClaimPath;
  /** `'user'`, `'service'` or `'workload'`, or the path that holds one. */
  readonly kind?: string;
  readonly assurance?:
    | string
    | {
        readonly acr?: string;
        readonly amr?: string;
        readonly authTime?: string;
        /** OpenID Connect for Identity Assurance; default `verified_claims`. */
        readonly verified?: string;
      };
  readonly session?: ClaimPath;
};

/** The value at `path`; a function that throws reads as absent, so a bad mapping fails closed. */
export function readClaim(
  claims: Readonly<Record<string, unknown>>,
  path: ClaimPath,
): unknown {
  if (typeof path === "string") {
    return readPath(claims, path);
  }
  try {
    return path(claims);
  } catch {
    return undefined;
  }
}
