import type { CustomRole, CustomRoleGrant, Membership } from "./subject.ts";
import type { Instant } from "./time.ts";
import type { VersionCache } from "./version-cache.ts";

import { compact, isRecord } from "./compact.ts";
import { readMemberships } from "./read-memberships.ts";
import { nowMillis } from "./time.ts";

/** One user as `subject_for(p_user)` returns it. */
export type SubjectRecord = {
  readonly id: string;
  /** `false` for a suspended user, who holds no roles or memberships. */
  readonly active: boolean;
  readonly roles: readonly string[];
  readonly memberships: readonly Membership[];
  readonly customRoles: readonly CustomRole[];
  readonly authzVersion?: number;
  /**
   * The token claims the hook adds besides the memberships: `team_ids` and each
   * `supabase.hook.claims` entry.
   */
  readonly claims?: Readonly<Record<string, unknown>>;
};

/**
 * Subject records kept across instances, so a source reads `subject_for` once
 * per authorization version instead of once per request. A cache never decides
 * anything: it answers a record or `null`, and the source reads on `null`.
 */
export type SubjectCache = {
  readonly name?: string;
  /**
   * The record held for `id`, or `null`. With a `version` (the one the instance
   * resolved), only a record at exactly that version answers, and a record
   * below it is dropped. With none, a record answers while it is younger than
   * the cache's staleness window and at the version the cache's `VersionCache`
   * holds.
   */
  record: (
    id: string,
    version: number | undefined,
  ) => SubjectRecord | null | Promise<SubjectRecord | null>;
  /**
   * Stores a record a source read. A record whose `authzVersion` is below the
   * cached record's, or below the version cache's entry, is refused, as is one
   * with no version when a versioned record is held.
   */
  seed: (record: SubjectRecord) => void | Promise<void>;
  /** Drops the record of `id`. */
  evict: (id: string) => void | Promise<void>;
};

export type MemorySubjectCacheOptions = {
  /** Records kept; the least recently used goes first. Default 10,000. */
  readonly maxEntries?: number;
  /**
   * How long a record answers a read made with no known version, in
   * milliseconds, as for `memoryVersionCache`. Default 0: such a read always
   * misses.
   */
  readonly maxStaleMs?: number;
  /**
   * The version cache `seed` and a read with no known version compare with, so
   * a record older than the version the process already saw is refused.
   */
  readonly versions?: VersionCache;
  /** The clock, read only when a record is stored or read. */
  readonly now?: () => Instant;
};

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function grantOf(value: unknown): CustomRoleGrant | undefined {
  if (!isRecord(value) || typeof value["permission"] !== "string") {
    return undefined;
  }
  return compact<CustomRoleGrant>({
    permission: value["permission"],
    effect: value["effect"] === "deny" ? "deny" : "allow",
    level: typeof value["level"] === "string" ? value["level"] : undefined,
  });
}

function customRoleOf(value: unknown): CustomRole | undefined {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    return undefined;
  }
  const grants = Array.isArray(value["grants"])
    ? value["grants"].flatMap((item) => {
        const grant = grantOf(item);
        return grant === undefined ? [] : [grant];
      })
    : [];
  const includes = strings(value["includes"]);
  const body = {
    name: value["name"],
    grants,
    ...(includes.length === 0 ? {} : { includes }),
  };
  if (value["scope"] === "global") {
    return value["tenant"] === undefined && value["shared"] === undefined
      ? { ...body, scope: "global" }
      : undefined;
  }
  if (value["shared"] === true) {
    return value["tenant"] === undefined && value["id"] === undefined
      ? compact<CustomRole>({
          ...body,
          shared: true,
          scope:
            typeof value["scope"] === "string" ? value["scope"] : undefined,
        })
      : undefined;
  }
  if (typeof value["tenant"] !== "string") {
    return undefined;
  }
  return compact<CustomRole>({
    ...body,
    tenant: value["tenant"],
    scope: typeof value["scope"] === "string" ? value["scope"] : undefined,
    id: typeof value["id"] === "string" ? value["id"] : undefined,
  });
}

/**
 * Reads `subject_for`'s JSON; anything it cannot read is left out, and a
 * malformed record is no record.
 */
export function readSubjectRecord(value: unknown): SubjectRecord | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  if (value["active"] !== true) {
    return {
      id: value["id"],
      active: false,
      roles: [],
      memberships: [],
      customRoles: [],
    };
  }
  const version = value["authzVersion"];
  return compact<SubjectRecord>({
    id: value["id"],
    active: true,
    roles: strings(value["roles"]),
    memberships: readMemberships(value["memberships"]).memberships,
    customRoles: Array.isArray(value["customRoles"])
      ? value["customRoles"].flatMap((item) => {
          const role = customRoleOf(item);
          return role === undefined ? [] : [role];
        })
      : [],
    authzVersion:
      typeof version === "number" && Number.isFinite(version)
        ? version
        : undefined,
    claims:
      isRecord(value["claims"]) && Object.keys(value["claims"]).length > 0
        ? value["claims"]
        : undefined,
  });
}

const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_STALE_CEILING_MS = 60_000;

type Entry = { readonly record: SubjectRecord; readonly at: number };

/**
 * An in-process `SubjectCache`: a bounded LRU keyed by principal id. Create it
 * once at module scope and pass it as `subjects`.
 */
export function memorySubjectCache(
  options: MemorySubjectCacheOptions = {},
): SubjectCache {
  const maxEntries = Math.max(
    Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
    1,
  );
  const maxStaleMs = Math.min(
    Math.max(Math.floor(options.maxStaleMs ?? 0), 0),
    MAX_STALE_CEILING_MS,
  );
  const entries = new Map<string, Entry>();
  const now = (): number => nowMillis(options.now?.());
  const store = (entry: Entry): void => {
    entries.delete(entry.record.id);
    entries.set(entry.record.id, entry);
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done !== true) {
        entries.delete(oldest.value);
      }
    }
  };
  /** The version the version cache holds, never reading. */
  const known = (id: string): number | undefined => {
    const answer = options.versions?.current({ id }, () => undefined, {
      live: false,
    });
    return typeof answer === "number" ? answer : undefined;
  };
  return Object.freeze({
    name: "memory",
    record(id, version) {
      const entry = entries.get(id);
      if (entry === undefined) {
        return null;
      }
      const held = entry.record.authzVersion;
      if (version !== undefined) {
        if (held === version) {
          store(entry);
          return entry.record;
        }
        if (held === undefined || held < version) {
          entries.delete(id);
        }
        return null;
      }
      const current = known(id);
      if (
        maxStaleMs === 0 ||
        now() - entry.at > maxStaleMs ||
        (current !== undefined && held !== current)
      ) {
        return null;
      }
      store(entry);
      return entry.record;
    },
    seed(record) {
      const version = record.authzVersion;
      const held = entries.get(record.id)?.record.authzVersion;
      if (version === undefined) {
        if (held !== undefined) {
          return;
        }
      } else if (
        version < (held ?? version) ||
        version < (known(record.id) ?? version)
      ) {
        return;
      }
      store({ record, at: now() });
    },
    evict(id) {
      entries.delete(id);
    },
  });
}
