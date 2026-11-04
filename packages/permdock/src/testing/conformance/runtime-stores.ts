import { expect, it } from "vitest";

import type {
  DecisionSink,
  InstanceCache,
  LimitStore,
  Policy,
  PolicyDocument,
  PolicySource,
  SnapshotSource,
  SubjectCache,
  SubjectRecord,
  VersionCache,
  VersionStore,
} from "../../index.ts";

import { isoNow } from "../../core/time.ts";
import { mergeHostedGrants, parsePolicyDocument } from "../../index.ts";

export function testLimitStore(store: LimitStore): void {
  it("counts down synchronously and fails closed when exhausted", async () => {
    const input = {
      key: "report.export",
      subjectId: "u_1",
      count: 2,
      per: 3600,
      now: { epochMilliseconds: 1_700_000_000_000 },
    };
    const first = await store.consume(input);
    expect(first.remaining).toBeGreaterThanOrEqual(0);
    const peeked = store.remaining(input);
    if (peeked !== undefined) {
      expect(peeked.remaining).toBeTypeOf("number");
      expect(
        peeked !== null &&
          typeof peeked === "object" &&
          "then" in peeked &&
          typeof peeked.then === "function",
      ).toBe(false);
    }
    await store.consume(input);
    const exhausted = await store.consume(input);
    expect(exhausted.remaining).toBeLessThan(0);
  });
}

export function testDecisionSink(sink: DecisionSink): void {
  it("accepts batches and never propagates write errors", async () => {
    await expect(
      Promise.resolve(
        sink.write([
          {
            type: "membership",
            at: isoNow(),
            source: "app",
            operation: "changed",
            principal: { id: "u_1" },
            roles: { added: ["admin"], removed: ["member"] },
          },
        ]),
      ),
    ).resolves.toBeUndefined();
    await expect(Promise.resolve(sink.write([]))).resolves.toBeUndefined();
    if (sink.flush !== undefined) {
      await expect(Promise.resolve(sink.flush())).resolves.toBeUndefined();
      await expect(Promise.resolve(sink.flush())).resolves.toBeUndefined();
    }
  });
}

export function testSnapshotSource(source: SnapshotSource): void {
  it("round-trips a snapshot", async () => {
    const snapshot = await source.get();
    expect(snapshot === null || snapshot === undefined).toBe(false);
    if (typeof snapshot === "object" && snapshot !== null && "v" in snapshot) {
      expect(snapshot.v).toBe(1);
    }
    if (source.subscribe !== undefined) {
      const unsubscribe = source.subscribe(() => undefined);
      unsubscribe();
    }
  });
}

export function testPolicySource(
  source: PolicySource,
  options: { readonly policy?: Policy } = {},
): void {
  const readCurrent = (): PolicyDocument | null => {
    const document = source.current();
    expect(
      document !== null &&
        typeof document === "object" &&
        "then" in document &&
        typeof document.then === "function",
    ).toBe(false);
    return document;
  };

  it("returns null or a v1 policy document synchronously", () => {
    const document = readCurrent();
    if (document !== null) {
      expect(parsePolicyDocument(document)).toStrictEqual(document);
    }
  });

  it("refreshes without rejecting and keeps current() synchronous", async () => {
    await expect(Promise.resolve(source.refresh())).resolves.toBeUndefined();
    const document = readCurrent();
    if (document !== null) {
      expect(document.v).toBe(1);
    }
  });

  if (options.policy !== undefined) {
    const policy = options.policy;
    it("merges only grants on hostable permissions", () => {
      const document = readCurrent();
      const merged = mergeHostedGrants(policy, document);
      for (const grant of merged.policy.grants) {
        if (grant.hosted !== undefined) {
          expect(policy.hostable).toContain(grant.permission.key);
        }
      }
      for (const dropped of merged.dropped) {
        expect(dropped.kind).toBe("hosted-grant-dropped");
      }
    });
  }
}

export function testVersionStore(store: VersionStore): void {
  it("answers what it stored and nothing for an unknown id", async () => {
    expect(await store.get("u-store-unknown")).toBeUndefined();
    await store.set("u-store-set", 7);
    expect(await store.get("u-store-set")).toBe(7);
  });

  it("overwrites a version and forgets a deleted id", async () => {
    await store.set("u-store-delete", 1);
    await store.set("u-store-delete", 2);
    expect(await store.get("u-store-delete")).toBe(2);
    await store.delete("u-store-delete");
    expect(await store.get("u-store-delete")).toBeUndefined();
    await store.delete("u-store-delete");
  });
}

export function testVersionCache(cache: VersionCache): void {
  const counted = (version: number) => {
    const calls = { count: 0 };
    const read = async (): Promise<number> => {
      calls.count += 1;
      return version;
    };
    return { calls, read };
  };

  it("reads live for a write and answers a read from that entry", async () => {
    const { calls, read } = counted(4);
    const principal = { id: "u-version-write" };
    expect(await cache.current(principal, read, { live: true })).toBe(4);
    expect(await cache.current(principal, read, { live: true })).toBe(4);
    expect(calls.count).toBe(2);
    if (cache.maxStaleMs > 0) {
      expect(await cache.current(principal, read, { live: false })).toBe(4);
      expect(calls.count).toBe(2);
    }
  });

  it("shares one read between concurrent reads", async () => {
    const { calls, read } = counted(2);
    const principal = { id: "u-version-shared" };
    const answers = await Promise.all(
      Array.from({ length: 5 }, async () =>
        cache.current(principal, read, { live: false }),
      ),
    );
    expect(answers).toStrictEqual([2, 2, 2, 2, 2]);
    expect(calls.count).toBe(1);
  });

  it("stores no rejected read", async () => {
    const principal = { id: "u-version-failed" };
    await expect(
      cache.current(principal, () => Promise.reject(new Error("down")), {
        live: false,
      }),
    ).rejects.toThrow("down");
    const { calls, read } = counted(1);
    expect(await cache.current(principal, read, { live: false })).toBe(1);
    expect(calls.count).toBe(1);
  });

  it("answers a read from a seed and never lowers a seeded version", async () => {
    const { calls, read } = counted(1);
    const principal = { id: "u-version-seed" };
    cache.seed(principal.id, 6);
    cache.seed(principal.id, 5);
    if (cache.maxStaleMs > 0) {
      expect(await cache.current(principal, read, { live: false })).toBe(6);
      expect(calls.count).toBe(0);
    }
  });

  it("reads again after evict", async () => {
    const { calls, read } = counted(3);
    const principal = { id: "u-version-evict" };
    await cache.current(principal, read, { live: false });
    cache.evict(principal.id);
    await cache.current(principal, read, { live: false });
    expect(calls.count).toBe(2);
    expect(cache.stats().reads).toBeGreaterThanOrEqual(2);
  });
}

/**
 * The `SubjectCache` contract: a record answers only at the version it was
 * stored at, a lower version never replaces a higher one, a read at a newer
 * version drops the record, and `evict` removes it.
 */
export function testSubjectCache(cache: SubjectCache): void {
  const recordAt = (id: string, authzVersion?: number): SubjectRecord => ({
    id,
    active: true,
    roles: ["staff"],
    memberships: [],
    customRoles: [],
    ...(authzVersion === undefined ? {} : { authzVersion }),
  });

  it("answers null for an unknown principal", async () => {
    expect(await cache.record("u-subject-unknown", 1)).toBeNull();
    expect(await cache.record("u-subject-unknown", undefined)).toBeNull();
  });

  it("answers a seeded record at its own version only", async () => {
    const seeded = recordAt("u-subject-seed", 4);
    await cache.seed(seeded);
    expect(await cache.record("u-subject-seed", 4)).toStrictEqual(seeded);
    expect(await cache.record("u-subject-seed", 3)).toBeNull();
    expect(await cache.record("u-subject-seed", 4)).toStrictEqual(seeded);
  });

  it("drops a record when a newer version is asked for", async () => {
    await cache.seed(recordAt("u-subject-newer", 2));
    expect(await cache.record("u-subject-newer", 3)).toBeNull();
    expect(await cache.record("u-subject-newer", 2)).toBeNull();
  });

  it("refuses a record below the cached version", async () => {
    const current = recordAt("u-subject-lower", 6);
    await cache.seed(current);
    await cache.seed(recordAt("u-subject-lower", 5));
    await cache.seed(recordAt("u-subject-lower"));
    expect(await cache.record("u-subject-lower", 6)).toStrictEqual(current);
    expect(await cache.record("u-subject-lower", 5)).toBeNull();
  });

  it("replaces a record with a newer one", async () => {
    await cache.seed(recordAt("u-subject-replace", 1));
    const next = { ...recordAt("u-subject-replace", 2), roles: ["admin"] };
    await cache.seed(next);
    expect(await cache.record("u-subject-replace", 2)).toStrictEqual(next);
    expect(await cache.record("u-subject-replace", 1)).toBeNull();
  });

  it("forgets a record after evict", async () => {
    await cache.seed(recordAt("u-subject-evict", 2));
    await cache.evict("u-subject-evict");
    expect(await cache.record("u-subject-evict", 2)).toBeNull();
  });
}

/**
 * The `InstanceCache` contract: one build per key while it lives, a shared
 * build in flight, no stored rejection, and `evict` dropping a principal's
 * entries.
 */
export function testInstanceCache(cache: InstanceCache): void {
  const key = (principal: string, version = 1) =>
    ({ principal, version, intent: "read", parts: {} }) as const;
  const counted = () => {
    const calls = { count: 0 };
    const build = async (): Promise<{ readonly n: number }> => {
      calls.count += 1;
      return { n: calls.count };
    };
    return { calls, build };
  };

  it("builds once per key and keys versions apart", async () => {
    const { calls, build } = counted();
    const first = await cache.instance(key("u-instance-key"), [], build);
    const again = await cache.instance(key("u-instance-key"), [], build);
    const next = await cache.instance(key("u-instance-key", 2), [], build);
    if (cache.maxAgeMs > 0) {
      expect(again).toBe(first);
      expect(calls.count).toBe(2);
    }
    expect(next).not.toBe(first);
  });

  it("shares one build between concurrent calls", async () => {
    const { calls, build } = counted();
    const built = await Promise.all(
      Array.from({ length: 5 }, async () =>
        cache.instance(key("u-instance-shared"), [], build),
      ),
    );
    expect(new Set(built).size).toBe(1);
    expect(calls.count).toBe(1);
  });

  it("stores no rejected build", async () => {
    await expect(
      cache.instance(key("u-instance-failed"), [], () =>
        Promise.reject(new Error("down")),
      ),
    ).rejects.toThrow("down");
    const { calls, build } = counted();
    await cache.instance(key("u-instance-failed"), [], build);
    expect(calls.count).toBe(1);
  });

  it("builds again after evict", async () => {
    const { calls, build } = counted();
    await cache.instance(key("u-instance-evict"), [], build);
    cache.evict("u-instance-evict");
    await cache.instance(key("u-instance-evict"), [], build);
    expect(calls.count).toBe(2);
  });
}
