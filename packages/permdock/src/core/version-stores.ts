import type { VersionStore, VersionStoreEntry } from "./version-cache.ts";

import { isRecord } from "./compact.ts";

const KEY_PREFIX = "permdock:authz-version:";

const entryOf = (value: unknown): VersionStoreEntry | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { version, at } = value;
  return typeof version === "number" &&
    Number.isFinite(version) &&
    typeof at === "number" &&
    Number.isFinite(at)
    ? { version, at }
    : undefined;
};

/**
 * The part of Vercel Runtime Cache (`getCache()` from `@vercel/functions`) that
 * `runtimeCacheVersionStore` uses.
 */
export type RuntimeCacheLike = {
  get: (key: string) => unknown;
  set: (
    key: string,
    value: unknown,
    options?: { readonly ttl?: number; readonly tags?: readonly string[] },
  ) => void | PromiseLike<void>;
  delete: (key: string) => void | PromiseLike<void>;
};

/**
 * A `VersionStore` over Vercel Runtime Cache, so every function instance in a
 * region shares one version read. The entry carries the database read time and
 * expires after `ttlSeconds` (default 60, the longest `maxStaleMs`).
 */
export function runtimeCacheVersionStore(
  cache: RuntimeCacheLike,
  options: { readonly ttlSeconds?: number } = {},
): VersionStore {
  const ttl = options.ttlSeconds ?? 60;
  return {
    async get(id) {
      return entryOf(await cache.get(`${KEY_PREFIX}${id}`));
    },
    async set(id, version, at) {
      await cache.set(
        `${KEY_PREFIX}${id}`,
        { version, at },
        { ttl, tags: [`${KEY_PREFIX}${id}`] },
      );
    },
    async delete(id) {
      await cache.delete(`${KEY_PREFIX}${id}`);
    },
  };
}

/** The part of a `pg` client or pool that `postgresCacheVersionStore` uses. */
export type QueryableLike = {
  query: (
    text: string,
    values?: readonly unknown[],
  ) => PromiseLike<{ readonly rows: readonly Record<string, unknown>[] }>;
};

const TABLE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/u;

/**
 * A `VersionStore` over a Postgres table `(user_id text primary key, version
 * bigint, at bigint)`, for an app that has no runtime cache. The table name is
 * checked against `schema.table` identifiers and never quoted from input.
 */
export function postgresCacheVersionStore(
  db: QueryableLike,
  table: string,
): VersionStore {
  if (!TABLE.test(table)) {
    throw new TypeError(
      `PermDock: postgresCacheVersionStore() needs a plain table name, got ${JSON.stringify(table)}`,
    );
  }
  return {
    async get(id) {
      const { rows } = await db.query(
        `select version::float8 as version, at::float8 as at from ${table} where user_id = $1`,
        [id],
      );
      return entryOf(rows[0]);
    },
    async set(id, version, at) {
      await db.query(
        `insert into ${table} (user_id, version, at) values ($1, $2, $3)
         on conflict (user_id) do update
         set version = greatest(${table}.version, excluded.version),
             at = case when excluded.version >= ${table}.version then excluded.at else ${table}.at end`,
        [id, version, at],
      );
    },
    async delete(id) {
      await db.query(`delete from ${table} where user_id = $1`, [id]);
    },
  };
}
