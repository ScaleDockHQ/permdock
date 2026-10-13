/**
 * The one time rule: NumericDate (whole seconds) for JWT registered claims
 * and the claims SQL reads, RFC 3339 for every other JSON field, integer
 * seconds for durations, and an `Instant` for every runtime `now`.
 */

/**
 * The part of a `Temporal.Instant` PermDock reads. Public options take it
 * structurally so their declarations compile under a TypeScript lib without
 * `Temporal` (5.9); every `Temporal.Instant` satisfies it.
 */
export type Instant = { readonly epochMilliseconds: number };

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

/** Whole seconds since the epoch of an RFC 3339 string or an `Instant`; `undefined` for anything else, Unix seconds included. */
export function instantOf(value: unknown): number | undefined {
  if (typeof value === "string") {
    return secondsOf(value);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "epochMilliseconds" in value &&
    typeof value.epochMilliseconds === "number" &&
    Number.isFinite(value.epochMilliseconds)
  ) {
    return Math.floor(value.epochMilliseconds / 1000);
  }
  return undefined;
}

/** A duration: a whole number of seconds above zero, else `undefined`. */
export function durationOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/** Throws at definition time unless `value` is a whole number of seconds above zero. */
export function assertDuration(
  value: unknown,
  label: string,
): asserts value is number {
  if (durationOf(value) === undefined) {
    throw new Error(
      `PermDock: ${label} must be a whole number of seconds above 0, got ${JSON.stringify(value) ?? String(value)}`,
    );
  }
}

/** Whole seconds since the epoch of `now`, or of the clock when absent. */
export function nowSeconds(now?: Instant): number {
  return Math.floor(nowMillis(now) / 1000);
}

/** Milliseconds since the epoch of `now`, or of the clock when absent. */
export function nowMillis(now?: Instant): number {
  return now === undefined ? Date.now() : now.epochMilliseconds;
}
