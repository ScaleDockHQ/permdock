import type { VersionQuery } from "./interfaces.ts";
import type { Instant } from "./time.ts";

import { isThenable } from "./thenable.ts";
import { nowMillis } from "./time.ts";

const MAX_STALE_CEILING_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export type VersionCacheStats = {
  /** Version reads the cache started. */
  readonly reads: number;
  /** Calls answered by a read already in flight. */
  readonly shared: number;
  /** Calls answered from an entry or a token claim, with no read. */
  readonly hits: number;
  readonly evictions: number;
  readonly size: number;
};

/**
 * Current authorization versions shared by every instance in a process:
 * `claimsFirst(source, { versions })` reads through it.
 */
export type VersionCache = {
  readonly name?: string;
  /** How old an entry may be when an instance with intent `read` uses it. */
  readonly maxStaleMs: number;
  /**
   * The current version of `principal`. With `live: false`, an entry at most
   * `maxStaleMs` old answers, a read in flight is shared, and a token claim
   * newer than the entry raises it; with `live: true`, `read` runs.
   */
  current: (
    principal: VersionQuery,
    read: () => number | undefined | Promise<number | undefined>,
    options: { readonly live: boolean },
  ) => number | undefined | Promise<number | undefined>;
  /** Drops `principal`'s entry, so the next instance reads the version. */
  evict: (principal: string) => void;
  stats: () => VersionCacheStats;
};

export type MemoryVersionCacheOptions = {
  /**
   * How stale a read may be, in milliseconds: the entry lifetime and the
   * longest a removed member keeps read access. Clamped to 0 to 60,000.
   */
  readonly maxStaleMs: number;
  /** Principals kept; the least recently used goes first. Default 10,000. */
  readonly maxEntries?: number;
  /** The clock, read only when an instance asks for a version. */
  readonly now?: () => Instant;
};

type Entry = { version: number; at: number };

/**
 * An in-process `VersionCache`: a bounded LRU keyed by principal id that keeps
 * resolved versions and shares reads in flight. Create it once at module
 * scope.
 */
export function memoryVersionCache(
  options: MemoryVersionCacheOptions,
): VersionCache {
  const maxStaleMs = Math.min(
    Math.max(Math.floor(options.maxStaleMs), 0),
    MAX_STALE_CEILING_MS,
  );
  const maxEntries = Math.max(
    Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
    1,
  );
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<number | undefined>>();
  const counts = { reads: 0, shared: 0, hits: 0, evictions: 0 };
  const now = (): number => nowMillis(options.now?.());
  const store = (id: string, entry: Entry): void => {
    entries.delete(id);
    entries.set(id, entry);
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done !== true) {
        entries.delete(oldest.value);
      }
    }
  };
  const observe = (principal: VersionQuery, at: number): void => {
    const claimed = principal.authzVersion;
    if (typeof claimed !== "number") {
      return;
    }
    const issued =
      typeof principal.issuedAt === "number"
        ? principal.issuedAt * 1000
        : undefined;
    const entry = entries.get(principal.id);
    if (entry === undefined) {
      if (issued !== undefined && issued <= at && at - issued <= maxStaleMs) {
        store(principal.id, { version: claimed, at: issued });
      }
      return;
    }
    if (claimed > entry.version) {
      store(principal.id, {
        version: claimed,
        at: issued === undefined ? entry.at : Math.max(entry.at, issued),
      });
    }
  };
  const start = (
    id: string,
    read: () => number | undefined | Promise<number | undefined>,
    at: number,
  ): number | undefined | Promise<number | undefined> => {
    counts.reads += 1;
    const keep = (version: number | undefined): number | undefined => {
      if (typeof version === "number" && Number.isFinite(version)) {
        const entry = entries.get(id);
        store(id, {
          version: Math.max(version, entry?.version ?? version),
          at,
        });
      }
      return version;
    };
    const answer = read();
    if (!isThenable(answer)) {
      return keep(answer);
    }
    const pending: Promise<number | undefined> = Promise.resolve(answer).then(
      (version) => (inFlight.get(id) === pending ? keep(version) : version),
    );
    inFlight.set(id, pending);
    const settle = (): void => {
      if (inFlight.get(id) === pending) {
        inFlight.delete(id);
      }
    };
    pending.then(settle, settle);
    return pending;
  };
  return Object.freeze({
    name: "memory",
    maxStaleMs,
    current(principal, read, { live }) {
      const at = now();
      if (live) {
        return start(principal.id, read, at);
      }
      observe(principal, at);
      const entry = entries.get(principal.id);
      if (entry !== undefined && at - entry.at <= maxStaleMs) {
        counts.hits += 1;
        store(principal.id, entry);
        return entry.version;
      }
      const pending = inFlight.get(principal.id);
      if (pending !== undefined) {
        counts.shared += 1;
        return pending;
      }
      return start(principal.id, read, at);
    },
    evict(principal) {
      counts.evictions += 1;
      entries.delete(principal);
      inFlight.delete(principal);
    },
    stats() {
      return { ...counts, size: entries.size };
    },
  });
}
