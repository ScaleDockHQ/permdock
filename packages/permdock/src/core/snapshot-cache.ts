import type { Snapshot } from "./interfaces.ts";

import { payloadDigest } from "./token.ts";

export type CacheLifeForOptions = {
  /** Lower bound in seconds. Next.js includes a private entry in per-link prefetches from 30. */
  readonly min?: number;
  /** Upper bound in seconds. Next.js keeps a per-session App Shell entry from 300. */
  readonly max?: number;
  /** Seconds since the epoch; defaults to the snapshot's `issuedAt`, then the clock. */
  readonly now?: number;
};

/**
 * `{ stale }` in seconds: `max` when the value never expires, otherwise the seconds left, clamped
 * to `[min, max]`. A value with less than `min` seconds left gets its real remainder, so Next.js
 * leaves it out of prefetches and an HTTP cache does not serve it past `expiresAt`.
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

/**
 * The `cacheTag` for one subject's cached snapshots: `permdock:<sub>`, or `permdock:anon`
 * without a subject. Tag the private cache with it and pass it to `updateTag` or
 * `revalidateTag` on every write that changes the subject's snapshot.
 */
export function snapshotTag(sub?: string | null): string {
  return `permdock:${sub === undefined || sub === null || sub === "" ? "anon" : sub}`;
}

export type SnapshotHeadersOptions = CacheLifeForOptions & {
  /** Sent in `Cache-Tag` after `snapshotTag(sub)`, such as the app's own organisation tag. */
  readonly tags?: readonly string[];
};

export type SnapshotHeaders = {
  readonly "Cache-Control": string;
  readonly Vary: string;
  readonly ETag: string;
  readonly "Cache-Tag": string;
};

/**
 * Response headers for a loader or route that returns `snapshot`: `Cache-Control: private` with
 * `max-age` from `cacheLifeFor`, `Vary: Authorization, Cookie`, an `ETag` over everything but
 * `issuedAt`, and `Cache-Tag` with `snapshotTag(sub)` and `tags`.
 */
export function snapshotHeaders(
  snapshot: Snapshot,
  options: SnapshotHeadersOptions = {},
): SnapshotHeaders {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key !== "issuedAt") {
      content[key] = value;
    }
  }
  const { tags, ...life } = options;
  return {
    "Cache-Control": `private, max-age=${cacheLifeFor(snapshot, life).stale}`,
    Vary: "Authorization, Cookie",
    ETag: `"${payloadDigest(content)}"`,
    "Cache-Tag": [
      snapshotTag(snapshot.subject.principal?.id),
      ...(tags ?? []),
    ].join(","),
  };
}
