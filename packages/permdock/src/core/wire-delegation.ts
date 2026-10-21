import type { AuthorizationDetail, Delegation, GnapAccess } from "./subject.ts";

import { compact, isRecord } from "./compact.ts";

/**
 * A delegation as every PermDock wire form carries it: OAuth `scope` (RFC 6749,
 * space-separated) and RFC 9396 `authorization_details`. An empty `scope` is an
 * empty scope list, which delegates nothing.
 */
export type WireDelegation = {
  readonly scope?: string;
  readonly authorization_details?: readonly AuthorizationDetail[];
  readonly access?: readonly GnapAccess[];
};

export function toWireDelegation(
  delegation: Delegation | undefined,
): WireDelegation | undefined {
  if (delegation === undefined) {
    return undefined;
  }
  return compact<WireDelegation>({
    scope: delegation.scopes?.join(" "),
    authorization_details: delegation.authorizationDetails,
    access: delegation.access,
  });
}

function scopeList(value: unknown): readonly string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.split(" ").filter((item) => item.length > 0);
}

/**
 * The runtime `Delegation` of a wire delegation. A field of the wrong type
 * becomes an empty scope list, so a malformed delegation narrows to nothing.
 */
export function fromWireDelegation(value: unknown): Delegation | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return { scopes: [] };
  }
  const scope = value["scope"];
  const details = value["authorization_details"];
  const access = value["access"];
  if (
    (scope !== undefined && typeof scope !== "string") ||
    (details !== undefined &&
      !(Array.isArray(details) && details.every(isDetail))) ||
    (access !== undefined && !Array.isArray(access))
  ) {
    return { scopes: [] };
  }
  return compact<Delegation>({
    scopes: scopeList(scope),
    // SAFETY: every entry passed isDetail above.
    authorizationDetails: details as readonly AuthorizationDetail[] | undefined,
    // SAFETY: an array; each entry is a GNAP access string or object, checked where it is matched.
    access: access as readonly GnapAccess[] | undefined,
  });
}

function isDetail(value: unknown): value is AuthorizationDetail {
  return isRecord(value) && typeof value["type"] === "string";
}
