import { describe, expect, it } from "vitest";

import type { QueryableLike, RuntimeCacheLike } from "../../src/index.ts";

import {
  postgresCacheVersionStore,
  runtimeCacheVersionStore,
} from "../../src/index.ts";
import { testVersionStore } from "../../src/testing/index.ts";

function mapCache(): RuntimeCacheLike {
  const data = new Map<string, unknown>();
  return {
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value);
    },
    delete: (key) => {
      data.delete(key);
    },
  };
}

describe("a runtime cache version store", () => {
  testVersionStore(runtimeCacheVersionStore(mapCache()));

  it("treats a value of another shape as a miss", async () => {
    const cache = mapCache();
    await cache.set("permdock:authz-version:u", 4);
    expect(await runtimeCacheVersionStore(cache).get("u")).toBeUndefined();
  });
});

describe("a Postgres version store", () => {
  it("refuses a table name that is not an identifier", () => {
    const db: QueryableLike = { query: () => Promise.resolve({ rows: [] }) };
    expect(() => postgresCacheVersionStore(db, "a; drop table b")).toThrow(
      TypeError,
    );
  });

  it("reads the stored version and its time", async () => {
    const calls: unknown[][] = [];
    const db: QueryableLike = {
      query: (_text, values) => {
        calls.push([...(values ?? [])]);
        return Promise.resolve({ rows: [{ version: 3, at: 10 }] });
      },
    };
    const store = postgresCacheVersionStore(db, "private.authz_versions");
    expect(await store.get("u")).toStrictEqual({ version: 3, at: 10 });
    await store.set("u", 4, 20);
    await store.delete("u");
    expect(calls).toStrictEqual([["u"], ["u", 4, 20], ["u"]]);
  });
});
