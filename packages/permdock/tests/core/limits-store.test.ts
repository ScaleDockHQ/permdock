import { describe, expect, it } from "vitest";

import type { LimitStore } from "../../src/core/interfaces.ts";
import type { QuotaInput } from "../../src/core/limits.ts";
import type { GrantLimit } from "../../src/core/policy-types.ts";

import { assertLimit } from "../../src/core/limit-grants.ts";
import { limits, memoryLimitStore } from "../../src/core/limits.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";

const permissions = definePermissions({
  report: resource({ id: "id", actions: ["export"] }),
});

const NOW = 1_800_000_000;

function quota(
  limit: GrantLimit,
  {
    store = memoryLimitStore(),
    ...overrides
  }: Partial<QuotaInput> & { readonly store?: LimitStore } = {},
) {
  return limits(store).quota({
    cache: new Map(),
    limit,
    permissionKey: permissions.report.export.key,
    subjectId: "u1",
    tenant: undefined,
    now: NOW,
    consume: false,
    ...overrides,
  });
}

describe("assertLimit windows", () => {
  it.each<{ per: unknown; valid: boolean }>([
    { per: 3600, valid: true },
    { per: 1, valid: true },
    { per: 0, valid: false },
    { per: -60, valid: false },
    { per: 1.5, valid: false },
    { per: Number.POSITIVE_INFINITY, valid: false },
    { per: "hour", valid: false },
    { per: "1h", valid: false },
  ])("accepts $per: $valid", ({ per, valid }) => {
    let message = "";
    try {
      // SAFETY: the invalid rows test what a caller without types can pass.
      assertLimit({ count: 1, per: per as number }, "report.export");
    } catch (error) {
      message = String(error);
    }
    expect(message.includes("must be a whole number of seconds")).toBe(!valid);
  });
});

describe("memoryLimitStore", () => {
  const input = {
    key: "k",
    subjectId: "u1",
    count: 2,
    per: 3600,
    now: { epochMilliseconds: NOW * 1000 },
  };

  it.each([
    { name: "a fractional window", change: { per: 1.5 } },
    { name: "a negative window", change: { per: -3600 } },
    { name: "a zero count", change: { count: 0 } },
    { name: "an infinite count", change: { count: Number.POSITIVE_INFINITY } },
  ])("fails closed on $name", ({ change }) => {
    const store = memoryLimitStore();
    expect({
      consumed: store.consume({ ...input, ...change }),
      peeked: store.remaining({ ...input, ...change }),
      size: store.size(),
    }).toStrictEqual({
      consumed: { remaining: -1 },
      peeked: { remaining: -1 },
      size: 0,
    });
  });

  it("sweeps only the counters whose window has passed", () => {
    const store = memoryLimitStore();
    store.consume({ ...input, key: "minute", per: 60 });
    store.consume({ ...input, key: "day", per: 86_400 });
    store.consume({
      ...input,
      key: "later",
      per: 3600,
      now: { epochMilliseconds: (NOW + 120) * 1000 },
    });
    expect(store.size()).toBe(2);
  });

  it("counts against the clock when no time is given", () => {
    const store = memoryLimitStore();
    const { now: _now, ...live } = input;
    expect([store.consume(live), store.remaining(live)]).toStrictEqual([
      { remaining: 1 },
      { remaining: 1 },
    ]);
  });
});

describe("limits() peeking", () => {
  const limit = { count: 3, per: 3600 };

  it("refuses a window no store can count", () => {
    expect(quota({ count: 3, per: 0.5 })).toStrictEqual({
      ok: false,
      reason: "limit-unavailable",
    });
  });

  it("falls back to the request cache when the store cannot peek", () => {
    const store = {
      consume: () => ({ remaining: 0 }),
      remaining: () => undefined,
    };
    const cache = new Map<string, number>();
    const missing = quota(limit, { store, cache });
    cache.set(
      JSON.stringify([
        null,
        "u1",
        "report.export",
        3600,
        String(Math.floor(NOW / 3600)),
      ]),
      2,
    );
    const cached = quota(limit, { store, cache });
    expect({ missing, cached }).toStrictEqual({
      missing: { ok: false, reason: "limit-unavailable" },
      cached: {
        ok: true,
        quota: {
          remaining: 1,
          resetsAt: new Date(
            (Math.floor(NOW / 3600) + 1) * 3_600_000,
          ).toISOString(),
        },
      },
    });
  });
});
