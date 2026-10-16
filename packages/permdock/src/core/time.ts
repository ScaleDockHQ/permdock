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

// oxlint-disable-next-line eslint/no-inline-comments -- bundlers only read the annotation inline
const RFC3339 = /* @__PURE__ */ new RegExp(RFC3339_PATTERN, "u");

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

/** The `validation` denial detail for a `now` option that is not an `Instant`. */
export const INVALID_NOW: { readonly field: "now"; readonly message: string } =
  Object.freeze({
    field: "now",
    message:
      "now must be an Instant ({ epochMilliseconds }), such as a Temporal.Instant",
  });

/** The `Date` of `now`, or of the clock when absent; throws a `RangeError` for a `now` that is not an `Instant`. */
export function dateAt(now?: Instant): Date {
  const millis = nowMillis(now);
  if (!Number.isFinite(millis)) {
    throw new RangeError(`PermDock: ${INVALID_NOW.message}`);
  }
  return new Date(millis);
}

/** Whole seconds since the epoch of `now`, or of the clock when absent; throws a `RangeError` for a `now` that is not an `Instant`. */
export function secondsAt(now?: Instant): number {
  return Math.floor(dateAt(now).getTime() / 1000);
}

/** The instant `seconds` after the epoch. */
export function instantAt(seconds: number): Instant {
  return { epochMilliseconds: seconds * 1000 };
}

/** Seconds since the epoch of `now`, fraction kept, or of the clock when absent. */
export function epochSeconds(now?: Instant): number {
  return nowMillis(now) / 1000;
}

/** Milliseconds since the epoch of `now`, or of the clock when absent; `NaN` for a `now` that is not an `Instant`. */
export function nowMillis(now?: Instant): number {
  if (now === undefined) {
    return Date.now();
  }
  const millis: unknown =
    typeof now === "object" && now !== null ? now.epochMilliseconds : undefined;
  return typeof millis === "number" ? millis : Number.NaN;
}
