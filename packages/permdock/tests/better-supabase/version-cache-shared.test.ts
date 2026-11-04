import { createVersionCache } from "better-supabase/server";
import { describe, expect, it } from "vitest";

import type { VersionStore } from "../../src/index.ts";

import {
  betterSupabaseVersionCache,
  isBetterSupabaseVersionCache,
  permdockFor,
} from "../../src/better-supabase/index.ts";
import { versionCacheOf } from "../../src/better-supabase/version-cache.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  instanceCache,
  memoryVersionCache,
  resource,
  role,
} from "../../src/index.ts";

const USER = "22222222-2222-4222-8222-222222222222";
const READ = { live: false } as const;

function mapStore(): VersionStore & { readonly data: Map<string, number> } {
  const data = new Map<string, number>();
  return {
    data,
    get: (id) => data.get(id),
    set: (id, version) => {
      data.set(id, version);
    },
    delete: (id) => {
      data.delete(id);
    },
  };
}

describe("cache defaults", () => {
  it("keeps a version and an instance for 30 seconds", () => {
    expect(memoryVersionCache().maxStaleMs).toBe(30_000);
    expect(instanceCache().maxAgeMs).toBe(30_000);
  });

  it("holds the 60 second ceiling", () => {
    expect(memoryVersionCache({ maxStaleMs: 600_000 }).maxStaleMs).toBe(60_000);
    expect(instanceCache({ maxAgeMs: 600_000 }).maxAgeMs).toBe(60_000);
  });
});

describe("memoryVersionCache shared store", () => {
  it("answers a second process from the store with no read", async () => {
    const store = mapStore();
    const first = memoryVersionCache({ shared: store });
    const second = memoryVersionCache({ shared: store });
    let reads = 0;
    const read = (): number => {
      reads += 1;
      return 7;
    };
    expect(await first.current({ id: USER }, read, READ)).toBe(7);
    expect(await second.current({ id: USER }, read, READ)).toBe(7);
    expect(await second.current({ id: USER }, read, READ)).toBe(7);
    expect(reads).toBe(1);
    expect(first.stats()).toStrictEqual({
      reads: 1,
      shared: 0,
      storeHits: 0,
      hits: 0,
      evictions: 0,
      size: 1,
    });
    expect(second.stats()).toStrictEqual({
      reads: 0,
      shared: 0,
      storeHits: 1,
      hits: 1,
      evictions: 0,
      size: 1,
    });
    expect(store.data.get(USER)).toBe(7);
  });

  it("reads live and writes the result to the store", async () => {
    const store = mapStore();
    store.data.set(USER, 1);
    const cache = memoryVersionCache({ shared: store });
    expect(await cache.current({ id: USER }, () => 4, { live: true })).toBe(4);
    expect(store.data.get(USER)).toBe(4);
    expect(cache.stats().storeHits).toBe(0);
  });

  it("deletes the stored version on evict", async () => {
    const store = mapStore();
    const cache = memoryVersionCache({ shared: store });
    cache.seed(USER, 2);
    expect(store.data.get(USER)).toBe(2);
    cache.evict(USER);
    expect(store.data.has(USER)).toBe(false);
  });

  it("reads the version when the store throws or rejects", async () => {
    const failing: VersionStore = {
      get: () => Promise.reject(new Error("down")),
      set: () => {
        throw new Error("down");
      },
      delete: () => Promise.reject(new Error("down")),
    };
    const cache = memoryVersionCache({ shared: failing });
    expect(await cache.current({ id: USER }, () => 5, READ)).toBe(5);
    cache.seed(USER, 6);
    cache.evict(USER);
    expect(cache.stats()).toStrictEqual({
      reads: 1,
      shared: 0,
      storeHits: 0,
      hits: 0,
      evictions: 1,
      size: 0,
    });
  });
});

describe("the better-supabase version cache adapter", () => {
  it("reads once, then answers from better-supabase's cache", async () => {
    const bs = createVersionCache({ maxStaleMs: 30_000 });
    const cache = betterSupabaseVersionCache(bs);
    let reads = 0;
    const read = (): number => {
      reads += 1;
      return 9;
    };
    expect(await cache.current({ id: USER }, read, READ)).toBe(9);
    expect(await cache.current({ id: USER }, read, READ)).toBe(9);
    expect(await bs.get(USER)).toBe(9);
    expect(reads).toBe(1);
    expect(cache.stats()).toStrictEqual({
      reads: 1,
      shared: 0,
      storeHits: 0,
      hits: 1,
      evictions: 0,
      size: 0,
    });
    await bs.evict(USER);
    expect(await cache.current({ id: USER }, read, READ)).toBe(9);
    expect(reads).toBe(2);
  });

  it("evicts through the adapter and seeds the higher version", async () => {
    const bs = createVersionCache({ maxStaleMs: 30_000 });
    const cache = betterSupabaseVersionCache(bs);
    cache.seed(USER, 3);
    await Promise.resolve();
    expect(await bs.get(USER)).toBe(3);
    cache.evict(USER);
    await Promise.resolve();
    expect(await bs.get(USER)).toBeUndefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it("returns one adapter per cache", () => {
    const bs = createVersionCache({ maxStaleMs: 30_000 });
    expect(betterSupabaseVersionCache(bs)).toBe(betterSupabaseVersionCache(bs));
  });

  it("tells the shapes apart by get and current", () => {
    const bs = createVersionCache({ maxStaleMs: 30_000 });
    expect(isBetterSupabaseVersionCache(bs)).toBe(true);
    expect(isBetterSupabaseVersionCache(memoryVersionCache())).toBe(false);
    expect(versionCacheOf(bs)).toBe(betterSupabaseVersionCache(bs));
    const own = memoryVersionCache();
    expect(versionCacheOf(own)).toBe(own);
    expect(versionCacheOf(undefined)).toBeUndefined();
  });

  it("serves permdockFor's sources from either shape", () => {
    const permissions = definePermissions({
      doc: resource(
        {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: (value: unknown) => ({ value }),
          },
        },
        {
          id: "id",
          actions: ["read"],
          relations: { org: { field: "org_id", memberOf: "organization" } },
        },
      ),
    });
    const policy = definePolicy(permissions, {
      scopes: { organization: { key: "org_id" } },
      subject: () => null,
      roles: [
        role("member", [allow(permissions.doc.read)], { on: "organization" }),
      ],
    });
    const resolve = permdockFor({ policy });
    const bs = createVersionCache({ maxStaleMs: 30_000 });
    expect(resolve.sources(bs)).toBe(resolve.sources(bs));
    expect(resolve.sources(bs)).toBe(
      resolve.sources(betterSupabaseVersionCache(bs)),
    );
  });
});
