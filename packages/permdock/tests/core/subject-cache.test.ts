import { describe, expect, it } from "vitest";

import type { SubjectRecord } from "../../src/index.ts";

import { memorySubjectCache, memoryVersionCache } from "../../src/index.ts";
import { testSubjectCache } from "../../src/testing/index.ts";

const record = (id: string, authzVersion?: number): SubjectRecord => ({
  id,
  active: true,
  roles: [],
  memberships: [],
  customRoles: [],
  ...(authzVersion === undefined ? {} : { authzVersion }),
});

describe(memorySubjectCache, () => {
  describe("contract", () => {
    testSubjectCache(memorySubjectCache());
  });

  describe("contract with a version cache and staleness", () => {
    testSubjectCache(
      memorySubjectCache({
        maxStaleMs: 5000,
        versions: memoryVersionCache({ maxStaleMs: 5000 }),
      }),
    );
  });

  it("evicts the least recently used record one at a time", async () => {
    const cache = memorySubjectCache({ maxEntries: 2 });
    await cache.seed(record("a", 1));
    await cache.seed(record("b", 1));
    expect(cache.record("a", 1)).not.toBeNull();
    await cache.seed(record("c", 1));
    expect(cache.record("b", 1)).toBeNull();
    expect(cache.record("a", 1)).not.toBeNull();
    expect(cache.record("c", 1)).not.toBeNull();
  });

  it("refuses a seed below the version cache's entry", async () => {
    const versions = memoryVersionCache({ maxStaleMs: 5000 });
    versions.seed("u", 7);
    const cache = memorySubjectCache({ versions });
    await cache.seed(record("u", 6));
    expect(cache.record("u", 6)).toBeNull();
    await cache.seed(record("u", 7));
    expect(cache.record("u", 7)).not.toBeNull();
  });

  it("answers a read with no version only while fresh and at the known version", async () => {
    let at = 1_000_000;
    const versions = memoryVersionCache({
      maxStaleMs: 5000,
      now: () => ({ epochMilliseconds: at }),
    });
    const cache = memorySubjectCache({
      maxStaleMs: 1000,
      versions,
      now: () => ({ epochMilliseconds: at }),
    });
    await cache.seed(record("u", 2));
    expect(cache.record("u", undefined)).not.toBeNull();
    versions.seed("u", 3, { epochMilliseconds: at });
    expect(cache.record("u", undefined)).toBeNull();
    await cache.seed(record("fresh", 1));
    at += 1001;
    expect(cache.record("fresh", undefined)).toBeNull();
  });

  it("misses a read with no version by default", async () => {
    const cache = memorySubjectCache();
    await cache.seed(record("u", 1));
    expect(cache.record("u", undefined)).toBeNull();
  });
});
