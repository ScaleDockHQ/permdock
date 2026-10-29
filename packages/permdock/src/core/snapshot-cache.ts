import type { Snapshot } from "./snapshot-types.ts";
import type { Instant } from "./time.ts";

import { nowSeconds, secondsOf } from "./time.ts";
import { payloadDigest } from "./token.ts";

export type CacheLifeForOptions = {
  /**
   * Lower bound in seconds. Next.js includes a private entry in per-link
   * prefetches from 30.
   */
  readonly min?: number;
  /** Upper bound in seconds. Next.js keeps a per-session App Shell entry from 300. */
  readonly max?: number;
  /**
   * Cap the lifetime at the seconds the token has left, as `bsb.cached()` does.
   * Off by default: a proxy that refreshes the session on every request keeps
   * the token ahead of the entry. `snapshotHeaders` turns it on, since an HTTP
   * cache sees no refresh.
   */
  readonly capToToken?: boolean;
  /** Defaults to the snapshot's `issuedAt`, then the clock. */
  readonly now?: Instant;
};

/** Seconds since the epoch of a NumericDate or an RFC 3339 instant. */
function epochSeconds(
  value: number | string | null | undefined,
): number | undefined {
  return typeof value === "number" ? value : secondsOf(value);
}

/**
 * `{ stale }` in seconds: `max` (default 300). With `capToToken`, the seconds
 * the value has left, clamped to `[min, max]`; a value with less than `min`
 * seconds left gets its real remainder, so Next.js leaves it out of prefetches
 * and an HTTP cache does not serve it past `expiresAt`.
 */
export function cacheLifeFor(
  value: {
    /** RFC 3339, or a NumericDate. */
    readonly expiresAt?: number | string | null;
    /** RFC 3339, or a NumericDate. */
    readonly issuedAt?: number | string;
  } | null,
  options: CacheLifeForOptions = {},
): { readonly stale: number } {
  const min = options.min ?? 30;
  const max = Math.max(options.max ?? 300, min);
  const expiresAt =
    options.capToToken === true ? epochSeconds(value?.expiresAt) : undefined;
  if (expiresAt === undefined) {
    return { stale: max };
  }
  const issued = epochSeconds(value?.issuedAt);
  const issuedAt = issued !== undefined && issued > 0 ? issued : undefined;
  const now =
    options.now === undefined
      ? (issuedAt ?? nowSeconds())
      : nowSeconds(options.now);
  const remaining = Math.floor(expiresAt - now);
  if (remaining < min) {
    return { stale: Math.max(0, remaining) };
  }
  return { stale: Math.min(max, remaining) };
}

/**
 * The key of one subject's snapshot in a server cache:
 * `<sub>:<authzVersion>:<tenant>`, with `anon` for no subject and an empty part
 * for a missing version or tenant. It carries no claims, so a refreshed token
 * at the same version keeps the key.
 */
export function snapshotKey(snapshot: Snapshot): string {
  const principal = snapshot.subject.principal;
  return [
    principal?.id ?? "anon",
    snapshot.authzVersion ?? "",
    principal?.tenant ?? "",
  ].join(":");
}

/**
 * The `cacheTag` for one subject's cached snapshots: `permdock:<sub>`, or
 * `permdock:anon` without a subject. Tag the private cache with it and pass it
 * to `updateTag` or `revalidateTag` on every write that changes the subject's
 * snapshot.
 */
export function snapshotTag(sub?: string | null): string {
  return `permdock:${sub === undefined || sub === null || sub === "" ? "anon" : sub}`;
}

export type SnapshotHeadersOptions = CacheLifeForOptions & {
  /**
   * Sent in `Cache-Tag` after `snapshotTag(sub)`, such as the app's own
   * organisation tag.
   */
  readonly tags?: readonly string[];
};

export type SnapshotHeaders = {
  readonly "Cache-Control": string;
  readonly Vary: string;
  readonly ETag: string;
  readonly "Cache-Tag": string;
};

/**
 * Response headers for a loader or route that returns `snapshot`:
 * `Cache-Control: private` with `max-age` from `cacheLifeFor`, `Vary:
 * Authorization, Cookie`, an `ETag` over everything but `issuedAt`, and
 * `Cache-Tag` with `snapshotTag(sub)` and `tags`.
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
    "Cache-Control": `private, max-age=${cacheLifeFor(snapshot, { capToToken: true, ...life }).stale}`,
    Vary: "Authorization, Cookie",
    ETag: `"${payloadDigest(content)}"`,
    "Cache-Tag": [
      snapshotTag(snapshot.subject.principal?.id),
      ...(tags ?? []),
    ].join(","),
  };
}
