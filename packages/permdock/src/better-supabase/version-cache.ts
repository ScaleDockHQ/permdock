import type { VersionCache, VersionCacheStats } from "../core/version-cache.ts";

import { isRecord } from "../core/compact.ts";

const DEFAULT_MAX_STALE_MS = 30_000;

/**
 * better-supabase's module-scope version cache (`createVersionCache`): `get`
 * answers the cached version, `seed` keeps the higher one and `evict` forgets a
 * user.
 */
export type BetterSupabaseVersionCache = {
  get: (userId: string) => number | undefined | PromiseLike<number | undefined>;
  seed?: (userId: string, version: number) => void | PromiseLike<void>;
  evict: (userId: string) => void | PromiseLike<void>;
};

/** Either cache shape a PermDock option or better-supabase's runtime may hold. */
export type AnyVersionCache = VersionCache | BetterSupabaseVersionCache;

export type BetterSupabaseVersionCacheOptions = {
  /**
   * Reported as `maxStaleMs`; the cache itself bounds staleness. Default
   * 30,000.
   */
  readonly maxStaleMs?: number;
};

const adapters = new WeakMap<BetterSupabaseVersionCache, VersionCache>();

function isFiniteVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function quiet(call: () => void | PromiseLike<void>): void {
  try {
    Promise.resolve(call()).catch(() => undefined);
  } catch {
    // A cache that fails is a miss; the next instance reads the version.
  }
}

/** better-supabase's cache is the one shape with `get` and no `current`. */
export function isBetterSupabaseVersionCache(
  value: unknown,
): value is BetterSupabaseVersionCache {
  return (
    isRecord(value) &&
    typeof value["get"] === "function" &&
    typeof value["current"] !== "function"
  );
}

/**
 * A PermDock `VersionCache` over better-supabase's `createVersionCache`, so
 * `claimsFirst(source, { versions })` and the cache `createNext({ versions })`
 * evicts are one store. A read answers from `get`; a version PermDock reads is
 * seeded back, and a failing cache reads the version itself.
 */
export function betterSupabaseVersionCache(
  cache: BetterSupabaseVersionCache,
  options: BetterSupabaseVersionCacheOptions = {},
): VersionCache {
  const known = adapters.get(cache);
  if (known !== undefined) {
    return known;
  }
  const inFlight = new Map<string, Promise<number | undefined>>();
  const counts = { reads: 0, shared: 0, storeHits: 0, hits: 0, evictions: 0 };
  const seed = (id: string, version: number | undefined): void => {
    if (isFiniteVersion(version) && cache.seed !== undefined) {
      const { seed: put } = cache;
      quiet(() => put.call(cache, id, version));
    }
  };
  const read = async (
    id: string,
    load: () => number | undefined | Promise<number | undefined>,
  ): Promise<number | undefined> => {
    counts.reads += 1;
    const version = await load();
    seed(id, version);
    return version;
  };
  const adapter: VersionCache = Object.freeze({
    name: "better-supabase",
    maxStaleMs: options.maxStaleMs ?? DEFAULT_MAX_STALE_MS,
    async current(principal, load, { live }) {
      if (live) {
        return read(principal.id, load);
      }
      try {
        const cached = await cache.get(principal.id);
        if (isFiniteVersion(cached)) {
          counts.hits += 1;
          return cached;
        }
      } catch {
        // A cache that fails answers nothing; the version is read.
      }
      const pending = inFlight.get(principal.id);
      if (pending !== undefined) {
        counts.shared += 1;
        return pending;
      }
      const started = read(principal.id, load);
      inFlight.set(principal.id, started);
      const settle = (): void => {
        if (inFlight.get(principal.id) === started) {
          inFlight.delete(principal.id);
        }
      };
      started.then(settle, settle);
      return started;
    },
    seed(principal, version) {
      if (Number.isFinite(version)) {
        seed(principal, version);
      }
    },
    evict(principal) {
      counts.evictions += 1;
      inFlight.delete(principal);
      quiet(() => cache.evict(principal));
    },
    stats(): VersionCacheStats {
      return { ...counts, size: 0 };
    },
  });
  adapters.set(cache, adapter);
  return adapter;
}

/** `versions` as a PermDock `VersionCache`, whichever shape it has. */
export function versionCacheOf(
  versions: AnyVersionCache | undefined,
): VersionCache | undefined {
  if (versions === undefined) {
    return undefined;
  }
  return isBetterSupabaseVersionCache(versions)
    ? betterSupabaseVersionCache(versions)
    : versions;
}
