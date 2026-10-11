import type { AuthorizationDetail, Delegation } from "./subject.ts";

import { compact } from "./compact.ts";

/**
 * RFC 9396 entries a token verifier put in `extra`, under
 * `authorizationDetails` or the claim's own `authorization_details`.
 */
export function authorizationDetailsOf(
  extra: Readonly<Record<string, unknown>> | undefined,
): readonly AuthorizationDetail[] | undefined {
  const details =
    extra?.["authorizationDetails"] ?? extra?.["authorization_details"];
  // SAFETY: extra comes from the server's token verifier; delegation matching compares each entry field by field.
  return Array.isArray(details)
    ? (details as readonly AuthorizationDetail[])
    : undefined;
}

/** The delegation a verified token's scopes and `extra` carry. */
export function delegationFrom(
  scopes: readonly string[] | undefined,
  extra: Readonly<Record<string, unknown>> | undefined,
): Delegation | undefined {
  return compact<Delegation>({
    scopes,
    authorizationDetails: authorizationDetailsOf(extra),
  });
}
