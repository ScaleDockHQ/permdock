import { expect, it } from "vitest";

import {
  type DecisionSink,
  type LimitStore,
  type Policy,
  type PolicyDocument,
  type PolicySource,
  type SnapshotSource,
  mergeHostedGrants,
  parsePolicyDocument,
} from "../../index.ts";

export function testLimitStore(store: LimitStore): void {
  it("counts down synchronously and fails closed when exhausted", async () => {
    const input = {
      key: "report.export",
      subjectId: "u_1",
      count: 2,
      per: "hour",
      now: 1_700_000_000,
    };
    const first = await store.consume(input);
    expect(first.remaining).toBeGreaterThanOrEqual(0);
    const peeked = store.remaining(input);
    if (peeked !== undefined) {
      expect(typeof peeked.remaining).toBe("number");
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
            at: new Date().toISOString(),
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
      expect(parsePolicyDocument(document)).toEqual(document);
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
