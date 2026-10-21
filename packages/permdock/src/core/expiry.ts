import { instantOf } from "./time.ts";

/**
 * `expiresAt` is Unix seconds; a membership with none never expires. One that
 * is not a number below infinity (`NaN`) has already expired: fail closed.
 */
export function expiredAt(
  item: { readonly expiresAt?: number },
  now: number,
): boolean {
  return item.expiresAt !== undefined && !(item.expiresAt > now);
}

/**
 * Unix seconds of a stored expiry: finite Unix seconds, an RFC 3339 string (the
 * Postgres `timestamptz` JSON form), a `Date` or an `Instant`. `undefined` for
 * anything else, which the caller treats as already expired.
 */
export function expirySeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? Math.floor(millis / 1000) : undefined;
  }
  return instantOf(value);
}
