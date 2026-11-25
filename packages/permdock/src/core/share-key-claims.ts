import type { Scope } from "./scopes.ts";

import { readMemberships } from "./read-memberships.ts";
import { tenantOf } from "./scopes.ts";

type Claims = Readonly<Record<string, unknown>>;

/**
 * Claims that mark a token's other lists as cut. A share key exists for no
 * token that carries one.
 */
export const OTHER_TRUNCATED_CLAIMS = [
  "team_ids_truncated",
  "permissions_truncated",
] as const;

/**
 * Whether a token whose `memberships` the budget cut still holds every
 * membership of `tenant`. The hook ranks the active tenant's entries first and
 * keeps a prefix, so a kept entry outside `tenant` means the prefix passed all
 * of them. With only `tenant` entries, or none, the cut may have fallen inside
 * them and the answer is no.
 */
export function holdsActiveTenant(
  claims: Claims,
  tenant: string,
  scopes: readonly Scope[],
): boolean {
  return readMemberships(claims["memberships"]).memberships.some(
    (membership) => tenantOf(membership, scopes) !== tenant,
  );
}

/**
 * What the claims alone decide about a share key for `tenant`: no other list is
 * cut, and the memberships are whole or provably whole for the tenant. The live
 * version check and `widened` keys can still refuse it.
 */
export function shareKeyClaimsEligible(
  claims: Claims,
  tenant: string,
  scopes: readonly Scope[],
): boolean {
  if (OTHER_TRUNCATED_CLAIMS.some((name) => claims[name] === true)) {
    return false;
  }
  return (
    claims["memberships_truncated"] !== true ||
    holdsActiveTenant(claims, tenant, scopes)
  );
}
