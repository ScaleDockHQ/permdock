import type { VersionQuery } from "./interfaces.ts";
import type { Instant } from "./time.ts";

import { isThenable } from "./thenable.ts";
import { nowMillis } from "./time.ts";

const MAX_STALE_CEILING_MS = 60_000;
const DEFAULT_MAX_STALE_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export type VersionCacheStats = {
  /** Version reads the cache started. */
  readonly reads: number;
  /** Calls answered by a read already in flight. */
  readonly shared: number;
  /** Local misses answered by the `shared` store, with no read. */
  readonly storeHits?: number;
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
   * `maxStaleMs` old answers and a read in flight is shared; with `live: true`,
   * `read` runs.
   */
  current: (
    principal: VersionQuery,
    read: () => number | undefined | Promise<number | undefined>,
    options: { readonly live: boolean },
  ) => number | undefined | Promise<number | undefined>;
  /**
   * Stores a version read at `at` (default now): `bsb.bootstrap()`'s
   * `authz_ver`, or a token claim dated by its `iat`. A seed never lowers a
   * cached version, and one dated in the future is ignored.
   */
  seed: (principal: string, version: number, at?: Instant) => void;
  /** Drops `principal`'s entry, so the next instance reads the version. */
  evict: (principal: string) => void;
  stats: () => VersionCacheStats;
};

/**
 * A store shared by every process, such as Redis or a runtime cache, behind
 * `memoryVersionCache({ shared })`. A rejected or thrown call counts as a
 * miss.
 */
export type VersionStore = {
  get: (id: string) => number | undefined | PromiseLike<number | undefined>;
  set: (id: string, version: number) => void | PromiseLike<void>;
  delete: (id: string) => void | PromiseLike<void>;
};

export type MemoryVersionCacheOptions = {
  /**
   * How stale a read may be, in milliseconds: the entry lifetime and the
   * longest a removed member keeps read access. Default 30,000; clamped to 0 to
   * 60,000.
   */
  readonly maxStaleMs?: number;
  /**
   * A store read on a local miss and written on every read and seed, so
   * instances share what one of them learned. Without one the cache is per
   * process.
   */
  readonly shared?: VersionStore;
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
  options: MemoryVersionCacheOptions = {},
): VersionCache {
  const maxStaleMs = Math.min(
    Math.max(Math.floor(options.maxStaleMs ?? DEFAULT_MAX_STALE_MS), 0),
    MAX_STALE_CEILING_MS,
  );
  const maxEntries = Math.max(
    Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
    1,
  );
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<number | undefined>>();
  const counts = { reads: 0, shared: 0, storeHits: 0, hits: 0, evictions: 0 };
  const { shared: remote } = options;
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
  const remember = (id: string, version: number): void => {
    if (remote === undefined) {
      return;
    }
    try {
      Promise.resolve(remote.set(id, version)).catch(() => undefined);
    } catch {
      // A store that fails is a miss; the next instance reads the version.
    }
  };
  const fromStore = async (
    id: string,
    read: () => number | undefined | Promise<number | undefined>,
  ): Promise<number | undefined> => {
    try {
      const known = await remote?.get(id);
      if (typeof known === "number" && Number.isFinite(known)) {
        counts.storeHits += 1;
        return known;
      }
    } catch {
      // A store that fails is a miss.
    }
    counts.reads += 1;
    return read();
  };
  const start = (
    id: string,
    read: () => number | undefined | Promise<number | undefined>,
    at: number,
    useStore: boolean,
  ): number | undefined | Promise<number | undefined> => {
    const keep = (version: number | undefined): number | undefined => {
      if (typeof version === "number" && Number.isFinite(version)) {
        const entry = entries.get(id);
        const highest = Math.max(version, entry?.version ?? version);
        store(id, { version: highest, at });
        remember(id, highest);
      }
      return version;
    };
    if (useStore && remote !== undefined) {
      return settled(id, fromStore(id, read), keep);
    }
    counts.reads += 1;
    const answer = read();
    if (!isThenable(answer)) {
      return keep(answer);
    }
    return settled(id, answer, keep);
  };
  const settled = (
    id: string,
    answer: PromiseLike<number | undefined> | Promise<number | undefined>,
    keep: (version: number | undefined) => number | undefined,
  ): Promise<number | undefined> => {
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
        return start(principal.id, read, at, false);
      }
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
      return start(principal.id, read, at, true);
    },
    seed(principal, version, at) {
      if (!Number.isFinite(version)) {
        return;
      }
      const current = now();
      const dated = at === undefined ? current : nowMillis(at);
      if (dated > current) {
        return;
      }
      const entry = entries.get(principal);
      if (entry === undefined) {
        if (current - dated <= maxStaleMs) {
          store(principal, { version, at: dated });
          remember(principal, version);
        }
        return;
      }
      if (
        version > entry.version ||
        (version === entry.version && dated > entry.at)
      ) {
        store(principal, { version, at: Math.max(entry.at, dated) });
        remember(principal, version);
      }
    },
    evict(principal) {
      counts.evictions += 1;
      entries.delete(principal);
      inFlight.delete(principal);
      if (remote !== undefined) {
        try {
          Promise.resolve(remote.delete(principal)).catch(() => undefined);
        } catch {
          // The entry still expires after `maxStaleMs`.
        }
      }
    },
    stats() {
      return { ...counts, size: entries.size };
    },
  });
}
