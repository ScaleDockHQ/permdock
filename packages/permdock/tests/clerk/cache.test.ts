import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClerkBackend } from "../../src/clerk/index.ts";

import { createClerkSubjectResolver } from "../../src/clerk/index.ts";

function countingBackend(fail = false): {
  readonly backend: ClerkBackend;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    backend: {
      users: {
        getOrganizationMembershipList: async () => {
          calls += 1;
          if (fail) {
            throw new Error("clerk down");
          }
          return [{ organizationId: "org_a", role: "org:member" }];
        },
      },
    },
    calls: () => calls,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createClerkSubjectResolver", () => {
  it("keeps a user's membership list for the cache ttl", async () => {
    vi.useFakeTimers();
    const { backend, calls } = countingBackend();
    const subject = createClerkSubjectResolver({
      memberships: "all",
      backend,
      cache: { ttl: "10s" },
    });
    const first = await subject({ sub: "u1", sid: "s1" });
    await subject({ sub: "u1", sid: "s2" });
    expect(first.principal?.memberships).toEqual([
      { tenant: "org_a", roles: ["org:member"] },
    ]);
    expect(calls()).toBe(1);
    await subject({ sub: "u2", sid: "s3" });
    expect(calls()).toBe(2);
    vi.advanceTimersByTime(10_000);
    await subject({ sub: "u1", sid: "s1" });
    expect(calls()).toBe(3);
  });

  it("loads every request without a cache and never caches a failure", async () => {
    const plain = countingBackend();
    const uncached = createClerkSubjectResolver({
      memberships: "all",
      backend: plain.backend,
    });
    await uncached({ sub: "u1", sid: "s1" });
    await uncached({ sub: "u1", sid: "s1" });
    expect(plain.calls()).toBe(2);
    const failing = countingBackend(true);
    const subject = createClerkSubjectResolver({
      memberships: "all",
      backend: failing.backend,
      cache: { ttl: 10_000 },
    });
    const denied = await subject({ sub: "u1", sid: "s1" });
    await subject({ sub: "u1", sid: "s1" });
    expect(denied.principal?.memberships).toEqual([]);
    expect(failing.calls()).toBe(2);
  });
});
