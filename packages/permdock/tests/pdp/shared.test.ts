import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import {
  cacheKey,
  joinUrl,
  resourceIdOf,
  ttlCache,
  ttlMs,
} from "../../src/pdp/shared.ts";

const permissions = definePermissions({
  post: resource(z.object({ id: z.string() }), { actions: ["read"] }),
});

describe(ttlMs, () => {
  const cases: readonly [Parameters<typeof ttlMs>[0], number][] = [
    [undefined, 0],
    [{ ttl: 1 }, 1000],
    [{ ttl: 5 }, 5000],
    [{ ttl: 30 }, 30_000],
    [{ ttl: 300 }, 30_000],
    [{ ttl: 0 }, 0],
    [{ ttl: -5 }, 0],
    [{ ttl: 0.5 }, 0],
    // SAFETY: a duration string a JavaScript caller could still pass.
    [{ ttl: "5s" as unknown as number }, 0],
    [{ ttl: Number.POSITIVE_INFINITY }, 0],
  ];

  it.each(cases)("maps %j to %d ms", (cache, expected) => {
    expect(ttlMs(cache)).toBe(expected);
  });
});

describe(resourceIdOf, () => {
  const cases: readonly [unknown, string | undefined, string][] = [
    [null, undefined, "*"],
    ["p1", undefined, "*"],
    [{ id: "p1" }, undefined, "p1"],
    [{ id: 7 }, undefined, "7"],
    [{ id: { nested: true } }, undefined, "*"],
    [{ key: "k1" }, "key", "k1"],
    [Object.create({ id: "inherited" }), undefined, "*"],
  ];

  it.each(cases)("reads %j with field %s as %s", (data, field, expected) => {
    expect(resourceIdOf(data, field)).toBe(expected);
  });
});

describe(cacheKey, () => {
  it("separates issuer, tenant and actor", () => {
    const base = cacheKey(
      { principal: { id: "u1", roles: [] }, context: {} },
      permissions.post.read,
      {},
    );
    const keys = new Set([
      base,
      cacheKey(
        {
          principal: { id: "u1", roles: [], issuer: "https://idp" },
          context: {},
        },
        permissions.post.read,
        {},
      ),
      cacheKey(
        { principal: { id: "u1", roles: [], tenant: "acme" }, context: {} },
        permissions.post.read,
        {},
      ),
      cacheKey(
        {
          principal: { id: "u1", roles: [] },
          actor: { id: "agent", kind: "mcp-client" },
          context: {},
        },
        permissions.post.read,
        {},
      ),
      cacheKey(
        { principal: { id: "u1", roles: [] }, context: {} },
        permissions.post.read,
        { id: "p2" },
      ),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe(ttlCache, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores nothing when the ttl is zero", () => {
    const cache = ttlCache<string>(0);
    cache.set("a", "value");
    expect(cache.get("a")).toBeUndefined();
  });

  it("expires entries after the ttl", () => {
    vi.useFakeTimers();
    const cache = ttlCache<string>(100);
    cache.set("a", "value");
    expect(cache.get("a")).toBe("value");
    vi.advanceTimersByTime(100);
    expect(cache.get("a")).toBeUndefined();
  });

  it("drops the oldest entry past 1000 entries", () => {
    const cache = ttlCache<number>(10_000);
    for (let index = 0; index <= 1000; index += 1) {
      cache.set(`k${index}`, index);
    }
    expect({ first: cache.get("k0"), last: cache.get("k1000") }).toStrictEqual({
      first: undefined,
      last: 1000,
    });
  });
});

describe(joinUrl, () => {
  const cases: readonly [string, string, string][] = [
    ["https://a.test", "/x", "https://a.test/x"],
    ["https://a.test/", "/x", "https://a.test/x"],
    ["https://a.test", "x", "https://a.test/x"],
    ["https://a.test", "https://b.test/y", "https://b.test/y"],
    ["https://a.test", "http://b.test/y", "http://b.test/y"],
  ];

  it.each(cases)("joins %s and %s", (base, path, expected) => {
    expect(joinUrl(base, path)).toBe(expected);
  });
});
