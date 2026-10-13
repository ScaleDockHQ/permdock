/**
 * The one time rule: NumericDate (whole seconds) for JWT registered claims
 * and the claims SQL reads, RFC 3339 for every other JSON field, integer
 * seconds for durations, and `Temporal.Instant` for every runtime `now`.
 */

/** RFC 3339 `date-time` in UTC or with an offset; fractional seconds optional. */
export const RFC3339_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$";

const RFC3339 = new RegExp(RFC3339_PATTERN, "u");

export function isRfc3339(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Seconds since the epoch as RFC 3339 in UTC. */
export function rfc3339(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Whole seconds since the epoch of an RFC 3339 instant; `undefined` for anything else. */
export function secondsOf(value: unknown): number | undefined {
  return isRfc3339(value) ? Math.floor(Date.parse(value) / 1000) : undefined;
}

/** Milliseconds since the epoch of an RFC 3339 instant; `undefined` for anything else. */
export function millisOf(value: unknown): number | undefined {
  return isRfc3339(value) ? Date.parse(value) : undefined;
}

/** Whole seconds since the epoch of `now`, or of the clock when absent. */
export function nowSeconds(now?: Temporal.Instant): number {
  return Math.floor(nowMillis(now) / 1000);
}

/** Milliseconds since the epoch of `now`, or of the clock when absent. */
export function nowMillis(now?: Temporal.Instant): number {
  return now === undefined ? Date.now() : now.epochMilliseconds;
}

/** A duration in whole positive seconds; `undefined` for anything else, so a caller fails closed. */
export function durationSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
