import type {
  CustomRoleSource,
  EntitlementSource,
  SourceContext,
} from "./interfaces.ts";

import { canonicalJson } from "./canonical-json.ts";
import { isThenable } from "./thenable.ts";

const MAX_AGE_CEILING_MS = 60_000;
const DEFAULT_MAX_AGE_MS = 5000;
const DEFAULT_MAX_ENTRIES = 10_000;

export type InstanceCacheStats = {
  /** Instances and source answers built or read. */
  readonly builds: number;
  /** Calls answered by a build already in flight. */
  readonly shared: number;
  /** Calls answered from an entry. */
  readonly hits: number;
  readonly evictions: number;
  readonly size: number;
};

/**
 * The key of one cached instance: who it serves, at which authorization
 * version, for which tenant and intent. `parts` holds everything else that
 * shapes the instance (the claims, the request scope); it is hashed.
 */
export type InstanceCacheKey = {
  readonly principal: string;
  readonly version: number;
  readonly tenant?: string;
  readonly intent: "read" | "write";
  readonly parts: unknown;
};

/**
 * Instances shared across requests: a subject at a known authorization version
 * gets the instance built for it, until `maxAgeMs` passes or `evict` drops it.
 * An instance whose version is unknown is never cached.
 */
export type InstanceCache = {
  readonly name?: string;
  /** The longest an instance, a custom role or an entitlement is reused. */
  readonly maxAgeMs: number;
  /**
   * The instance for `key`: a stored one, the build in flight, or `build()`. A
   * rejected build is not stored.
   */
  instance: <T>(
    key: InstanceCacheKey,
    owners: readonly unknown[],
    build: () => Promise<T>,
  ) => Promise<T>;
  /**
   * `source` with every answer kept for `maxAgeMs`, keyed by its arguments.
   * With `of`, the answers are keyed by `of.owner` and `of.principal` instead
   * of `source`, so the new source a `CustomRoleSourceFactory` returns per
   * subject reuses them, and `evict(of.principal)` drops them.
   */
  customRoles: (
    source: CustomRoleSource,
    of?: CustomRoleOwner,
  ) => CustomRoleSource;
  /** `source` with every answer kept for `maxAgeMs`, per principal and tenant. */
  entitlements: (source: EntitlementSource) => EntitlementSource;
  /**
   * Drops `principal`'s instances, entitlements and the answers of custom-role
   * sources cached for it.
   */
  evict: (principal: string) => void;
  stats: () => InstanceCacheStats;
};

/** The factory and principal a per-subject custom-role source belongs to. */
export type CustomRoleOwner = {
  readonly owner: object;
  readonly principal: string;
};

export type InstanceCacheOptions = {
  /** Entries kept; the least recently used goes first. Default 10,000. */
  readonly maxEntries?: number;
  /**
   * Milliseconds an entry is reused: the longest a custom-role or entitlement
   * change waits to reach an instance. Default 5,000; clamped to 0 to 60,000.
   */
  readonly maxAgeMs?: number;
  /** Epoch milliseconds. */
  readonly now?: () => number;
};

type Entry = {
  readonly value: unknown;
  readonly at: number;
  readonly principal: string | undefined;
};

function roleKey(method: string, args: readonly unknown[]): string {
  return `roles:${canonicalJson([method, ...args])}`;
}

function withoutMemo(context: SourceContext | undefined): unknown {
  if (context === undefined) {
    return null;
  }
  const { memo: _memo, ...rest } = context;
  return rest;
}

/**
 * An in-process `InstanceCache`: a bounded LRU that shares builds in flight.
 * Create it once at module scope and pass it as `instances` to every adapter of
 * the app; adapters with the same sources and policy share entries.
 */
export function instanceCache(
  options: InstanceCacheOptions = {},
): InstanceCache {
  const maxAgeMs = Math.min(
    Math.max(Math.floor(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS), 0),
    MAX_AGE_CEILING_MS,
  );
  const maxEntries = Math.max(
    Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
    1,
  );
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<unknown>>();
  const byPrincipal = new Map<string, Set<string>>();
  const ownerIds = new WeakMap<object, number>();
  let nextOwner = 0;
  const counts = { builds: 0, shared: 0, hits: 0, evictions: 0 };
  const ownerId = (owner: object): number => {
    const known = ownerIds.get(owner);
    if (known !== undefined) {
      return known;
    }
    nextOwner += 1;
    const id = nextOwner;
    ownerIds.set(owner, id);
    return id;
  };
  const forget = (id: string): void => {
    const entry = entries.get(id);
    entries.delete(id);
    if (entry?.principal !== undefined) {
      byPrincipal.get(entry.principal)?.delete(id);
    }
  };
  const store = (id: string, entry: Entry): void => {
    entries.delete(id);
    entries.set(id, entry);
    if (entry.principal !== undefined) {
      const keys = byPrincipal.get(entry.principal) ?? new Set<string>();
      keys.add(id);
      byPrincipal.set(entry.principal, keys);
    }
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done !== true) {
        forget(oldest.value);
      }
    }
  };
  const through = <T>(
    id: string,
    principal: string | undefined,
    build: () => T | Promise<T>,
  ): T | Promise<T> => {
    const at = now();
    const entry = entries.get(id);
    if (entry !== undefined && at - entry.at <= maxAgeMs) {
      counts.hits += 1;
      store(id, entry);
      // SAFETY: an entry under `id` holds what the build for `id` returned.
      return entry.value as T;
    }
    if (entry !== undefined) {
      forget(id);
    }
    const pending = inFlight.get(id);
    if (pending !== undefined) {
      counts.shared += 1;
      // SAFETY: a build in flight under `id` resolves to what the build for `id` returns.
      return pending as Promise<T>;
    }
    counts.builds += 1;
    const answer = build();
    if (!isThenable(answer)) {
      if (maxAgeMs > 0) {
        store(id, { value: answer, at, principal });
      }
      return answer;
    }
    const started: Promise<T> = Promise.resolve(answer).then((value) => {
      if (inFlight.get(id) === started && maxAgeMs > 0) {
        store(id, { value, at, principal });
      }
      return value;
    });
    inFlight.set(id, started);
    const settle = (): void => {
      if (inFlight.get(id) === started) {
        inFlight.delete(id);
      }
    };
    started.then(settle, settle);
    return started;
  };
  return Object.freeze({
    name: "memory",
    maxAgeMs,
    instance<T>(
      key: InstanceCacheKey,
      owners: readonly unknown[],
      build: () => Promise<T>,
    ): Promise<T> {
      const ids = owners.map((owner) =>
        (typeof owner === "object" && owner !== null) ||
        typeof owner === "function"
          ? ownerId(owner)
          : 0,
      );
      const id = `instance:${ids.join(",")}:${canonicalJson([
        key.principal,
        key.version,
        key.tenant ?? null,
        key.intent,
        key.parts,
      ])}`;
      return Promise.resolve(through(id, key.principal, build));
    },
    customRoles(
      source: CustomRoleSource,
      of?: CustomRoleOwner,
    ): CustomRoleSource {
      const sourceId =
        of === undefined
          ? String(ownerId(source))
          : `${String(ownerId(of.owner))}:${canonicalJson(of.principal)}`;
      const principal = of?.principal;
      const { globalRoles, sharedRoles, assignable } = source;
      return Object.freeze({
        ...(source.name === undefined ? {} : { name: source.name }),
        rolesFor: (tenant, context) =>
          through(
            roleKey(`${sourceId}:rolesFor`, [tenant, withoutMemo(context)]),
            principal,
            () => source.rolesFor(tenant, context),
          ),
        ...(assignable === undefined
          ? {}
          : {
              assignable: (tenant: string) =>
                through(
                  roleKey(`${sourceId}:assignable`, [tenant]),
                  principal,
                  () => assignable.call(source, tenant),
                ),
            }),
        ...(globalRoles === undefined
          ? {}
          : {
              globalRoles: (context?: Parameters<typeof globalRoles>[0]) =>
                through(
                  roleKey(`${sourceId}:globalRoles`, [withoutMemo(context)]),
                  principal,
                  () => globalRoles.call(source, context),
                ),
            }),
        ...(sharedRoles === undefined
          ? {}
          : {
              sharedRoles: (context?: Parameters<typeof sharedRoles>[0]) =>
                through(
                  roleKey(`${sourceId}:sharedRoles`, [withoutMemo(context)]),
                  principal,
                  () => sharedRoles.call(source, context),
                ),
            }),
      });
    },
    entitlements(source: EntitlementSource): EntitlementSource {
      const sourceId = ownerId(source);
      return Object.freeze({
        ...(source.name === undefined ? {} : { name: source.name }),
        entitlementsFor: (principal, scope) =>
          through(
            `entitlements:${sourceId}:${canonicalJson([
              principal.id,
              scope.tenant ?? null,
            ])}`,
            principal.id,
            () => source.entitlementsFor(principal, scope),
          ),
      });
    },
    evict(principal: string): void {
      counts.evictions += 1;
      const keys = byPrincipal.get(principal);
      byPrincipal.delete(principal);
      for (const id of keys ?? []) {
        entries.delete(id);
        inFlight.delete(id);
      }
    },
    stats(): InstanceCacheStats {
      return { ...counts, size: entries.size };
    },
  });
}
