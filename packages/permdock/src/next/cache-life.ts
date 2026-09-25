export type CacheLifeForOptions = {
  /** Lower bound in seconds. Next.js includes a private entry in per-link prefetches from 30. */
  readonly min?: number;
  /** Upper bound in seconds. Next.js keeps a per-session App Shell entry from 300. */
  readonly max?: number;
  /** Seconds since the epoch; defaults to the snapshot's `issuedAt`, then the clock. */
  readonly now?: number;
};

/**
 * `{ stale }` for `cacheLife()` inside an app-owned `'use cache: private'` function: `max` when the
 * value never expires, otherwise the seconds left, clamped to `[min, max]`. A value with less than
 * `min` seconds left gets its real remainder, so Next.js leaves it out of prefetches instead of
 * serving it past `expiresAt`.
 */
export function cacheLifeFor(
  value: {
    readonly expiresAt?: number | null;
    readonly issuedAt?: number;
  } | null,
  options: CacheLifeForOptions = {},
): { readonly stale: number } {
  const min = options.min ?? 30;
  const max = Math.max(options.max ?? 300, min);
  const expiresAt = value?.expiresAt;
  if (expiresAt === undefined || expiresAt === null) {
    return { stale: max };
  }
  const issuedAt =
    value?.issuedAt !== undefined && value.issuedAt > 0
      ? value.issuedAt
      : undefined;
  const now = options.now ?? issuedAt ?? Math.floor(Date.now() / 1000);
  const remaining = Math.floor(expiresAt - now);
  if (remaining < min) {
    return { stale: Math.max(0, remaining) };
  }
  return { stale: Math.min(max, remaining) };
}
