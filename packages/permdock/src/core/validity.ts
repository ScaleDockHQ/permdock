import type { GrantValidity, WireValidity } from "./policy-types.ts";
import type { Instant } from "./time.ts";

import { instantOf, rfc3339, secondsOf } from "./time.ts";

/**
 * The normalised validity of a grant, or `undefined` when neither bound is set.
 * Fail-closed at definition time: a bound that does not parse, or a window that
 * ends before it starts, throws so a typo never widens a grant.
 */
export function normalizeValidity(
  options: {
    readonly validFrom?: string | Instant;
    readonly validUntil?: string | Instant;
  },
  permissionKey: string,
): GrantValidity | undefined {
  const from =
    options.validFrom === undefined ? undefined : instantOf(options.validFrom);
  const until =
    options.validUntil === undefined
      ? undefined
      : instantOf(options.validUntil);
  if (options.validFrom !== undefined && from === undefined) {
    throw new Error(
      `PermDock: validFrom on '${permissionKey}' must be an RFC 3339 string or an Instant`,
    );
  }
  if (options.validUntil !== undefined && until === undefined) {
    throw new Error(
      `PermDock: validUntil on '${permissionKey}' must be an RFC 3339 string or an Instant`,
    );
  }
  if (from !== undefined && until !== undefined && until <= from) {
    throw new Error(
      `PermDock: validUntil on '${permissionKey}' must be after validFrom`,
    );
  }
  if (from === undefined && until === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(from === undefined ? {} : { from }),
    ...(until === undefined ? {} : { until }),
  });
}

/**
 * Whether a grant with this validity applies at `now` (Unix seconds); no
 * validity always applies.
 */
export function isActive(
  validity: GrantValidity | undefined,
  now: number,
): boolean {
  if (validity === undefined) {
    return true;
  }
  if (validity.from !== undefined && now < validity.from) {
    return false;
  }
  return validity.until === undefined || now < validity.until;
}

export function wireValidity(
  validity: GrantValidity | undefined,
): WireValidity | undefined {
  if (validity === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(validity.from === undefined ? {} : { from: rfc3339(validity.from) }),
    ...(validity.until === undefined ? {} : { until: rfc3339(validity.until) }),
  });
}

/**
 * The validity of a wire grant. A malformed window fails closed for the grant's
 * effect: an allow never applies (`{ from: +∞ }`), a deny always does (no
 * window), so a corrupt bound can never lift a deny.
 */
export function readWireValidity(
  value: unknown,
  effect: "allow" | "deny" = "allow",
): GrantValidity | undefined {
  if (value === undefined) {
    return undefined;
  }
  const malformed = effect === "deny" ? undefined : NEVER;
  if (typeof value !== "object" || value === null) {
    return malformed;
  }
  const from = "from" in value ? value.from : undefined;
  const until = "until" in value ? value.until : undefined;
  const start = from === undefined ? undefined : secondsOf(from);
  const end = until === undefined ? undefined : secondsOf(until);
  if (
    (from !== undefined && start === undefined) ||
    (until !== undefined && end === undefined)
  ) {
    return malformed;
  }
  return Object.freeze({
    ...(start === undefined ? {} : { from: start }),
    ...(end === undefined ? {} : { until: end }),
  });
}

const NEVER: GrantValidity = Object.freeze({ from: Number.POSITIVE_INFINITY });
