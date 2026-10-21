import { isoAt, isRfc3339 } from "./time.ts";

// ECMA-262 time values span ±8.64e15 ms from the epoch.
const MAX_TIME_VALUE = 8.64e15;

/**
 * An event time as RFC 3339, or `undefined` when there is none or it is not a
 * time: NumericDate seconds are converted and an RFC 3339 string passes
 * through. Never throws, so a decision event never fails on a malformed
 * expiry.
 */
export function eventInstant(
  value: number | string | undefined,
): string | undefined {
  if (typeof value === "string") {
    return isRfc3339(value) ? value : undefined;
  }
  if (typeof value !== "number") {
    return undefined;
  }
  const millis = value * 1000;
  return Math.abs(millis) <= MAX_TIME_VALUE ? isoAt(millis) : undefined;
}

/**
 * `eventInstant` for a builder input, where a malformed time is the caller's
 * error.
 */
export function requireEventInstant(
  value: number | string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const instant = eventInstant(value);
  if (instant === undefined) {
    throw new RangeError(`PermDock: ${field} is not an RFC 3339 instant`);
  }
  return instant;
}
