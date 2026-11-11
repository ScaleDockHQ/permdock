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
  /**
   * The tenant a `subject_for(p_user, p_tenant)` read was scoped to. Absent for
   * the all-tenants record. A scoped record is a different record from the
   * all-tenants one and from another tenant's.
   */
  readonly tenant?: string;
  readonly authzVersion?: number;
  /**
   * The custom-role version of each tenant the user holds a custom role in,
   * read with the record. A cached record answers a read at a tenant version
   * only while the two are equal, so an edit of a role is never served stale.
   */
  readonly customRolesVersions?: Readonly<Record<string, number>>;
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
   * holds. With `roles`, the custom-role version read for each tenant, a record
   * whose version for any of them differs is not served either, and a record
   * below one is dropped. With `tenant`, only the record read for that tenant
   * answers; without it, only the all-tenants record does.
   */
  record: (
    id: string,
    version: number | undefined,
    roles?: Readonly<Record<string, number>>,
    tenant?: string,
  ) => SubjectRecord | null | Promise<SubjectRecord | null>;
  /**
   * Stores a record a source read. A record whose `authzVersion` is below the
   * cached record's, or below the version cache's entry, is refused, as is one
   * with no version when a versioned record is held.
   */
  seed: (record: SubjectRecord) => void | Promise<void>;
  /** Drops every record of `id`, whatever its tenant. */
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
 * malformed record is no record. A `tenant` field marks a record read for one
 * tenant, so a seed of it never stands in for the all-tenants record.
 */
export function readSubjectRecord(value: unknown): SubjectRecord | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  const tenant =
    typeof value["tenant"] === "string" && value["tenant"] !== ""
      ? value["tenant"]
      : undefined;
  if (value["active"] !== true) {
    return compact<SubjectRecord>({
      id: value["id"],
      active: false,
      roles: [],
      memberships: [],
      customRoles: [],
      tenant,
    });
  }
  const version = value["authzVersion"];
  const rolesVersions = rolesVersionsOf(value["customRolesVersions"]);
  return compact<SubjectRecord>({
    id: value["id"],
    active: true,
    tenant,
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
    customRolesVersions:
      rolesVersions === undefined || Object.keys(rolesVersions).length === 0
        ? undefined
        : rolesVersions,
    claims:
      isRecord(value["claims"]) && Object.keys(value["claims"]).length > 0
        ? value["claims"]
        : undefined,
  });
}

function rolesVersionsOf(
  value: unknown,
): Readonly<Record<string, number>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const versions: Record<string, number> = {};
  for (const [tenant, version] of Object.entries(value)) {
    const number = typeof version === "string" ? Number(version) : version;
    if (typeof number === "number" && Number.isSafeInteger(number)) {
      versions[tenant] = number;
    }
  }
  return versions;
}

/** Whether `record` holds exactly the custom-role versions in `roles`. */
function rolesMatch(
  record: SubjectRecord,
  roles: Readonly<Record<string, number>>,
): boolean {
  return Object.entries(roles).every(
    ([tenant, current]) => record.customRolesVersions?.[tenant] === current,
  );
}

/** Whether `record` is below a version in `roles`, or has none for the tenant. */
function rolesBehind(
  record: SubjectRecord,
  roles: Readonly<Record<string, number>>,
): boolean {
  return Object.entries(roles).some(([tenant, current]) => {
    const held = record.customRolesVersions?.[tenant];
    return held === undefined || held < current;
  });
}

const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_STALE_CEILING_MS = 60_000;

const TENANT_SEPARATOR = "\u0000";

function keyOf(id: string, tenant: string | undefined): string {
  return tenant === undefined ? id : `${id}${TENANT_SEPARATOR}${tenant}`;
}

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
    const key = keyOf(entry.record.id, entry.record.tenant);
    entries.delete(key);
    entries.set(key, entry);
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
    record(id, version, roles, tenant) {
      const key = keyOf(id, tenant);
      const entry = entries.get(key);
      if (entry === undefined) {
        return null;
      }
      const held = entry.record.authzVersion;
      if (version !== undefined) {
        if (held === version) {
          if (roles !== undefined && !rolesMatch(entry.record, roles)) {
            if (rolesBehind(entry.record, roles)) {
              entries.delete(key);
            }
            return null;
          }
          store(entry);
          return entry.record;
        }
        if (held === undefined || held < version) {
          entries.delete(key);
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
      const held = entries.get(keyOf(record.id, record.tenant))?.record
        .authzVersion;
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
      const scoped = `${id}${TENANT_SEPARATOR}`;
      for (const key of entries.keys()) {
        if (key.startsWith(scoped)) {
          entries.delete(key);
        }
      }
    },
  });
}
