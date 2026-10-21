import { expect, it } from "vitest";

import type {
  Decision,
  DecisionProvider,
  Permission,
  Subject,
} from "../../index.ts";
import type { SnapshotStorage } from "../../react-native/types.ts";

const OUTCOMES = ["granted", "denied", "approval-required"];

const LOCAL: Decision = Object.freeze({
  outcome: "denied",
  denials: Object.freeze([Object.freeze({ role: null, reason: "no-grant" })]),
  alternatives: Object.freeze([]),
});

export type DecisionProviderRunnerOptions = {
  /** A permission the provider handles. */
  readonly permission: Permission;
  readonly subject: Subject;
  readonly data?: unknown;
  /** The same provider wired to a transport that fails; it must deny. */
  readonly unavailable?: DecisionProvider;
};

function expectDecision(decision: Decision): void {
  expect(OUTCOMES).toContain(decision.outcome);
  if (decision.outcome === "denied") {
    expect(decision.denials.length).toBeGreaterThan(0);
  }
}

export function testDecisionProvider(
  provider: DecisionProvider,
  options: DecisionProviderRunnerOptions,
): void {
  const request = Object.freeze({
    permission: options.permission,
    data: options.data,
    subject: options.subject,
    local: LOCAL,
  });

  it("names itself and claims the permission synchronously", () => {
    expect(provider.name).toBeTypeOf("string");
    expect(provider.name.length).toBeGreaterThan(0);
    expect(provider.handles(options.permission)).toBe(true);
  });

  it("answers decide with one of the three outcomes", async () => {
    expectDecision(await provider.decide(request));
  });

  it("lists permitted ids as non-empty strings, or null or undefined", async () => {
    const ids =
      provider.permitted === undefined
        ? undefined
        : await provider.permitted({
            permission: options.permission,
            subject: options.subject,
          });
    expect(
      ids === null ||
        ids === undefined ||
        ids.every((id) => typeof id === "string" && id.length > 0),
    ).toBe(true);
  });

  it("denies without throwing when its transport fails", async () => {
    const unavailable = options.unavailable;
    const decision =
      unavailable === undefined
        ? undefined
        : await unavailable.decide(request).catch(() => undefined);
    expect(unavailable === undefined || decision?.outcome === "denied").toBe(
      true,
    );
  });
}

export function testSnapshotStorage(storage: SnapshotStorage): void {
  const key = `permdock.conformance.${globalThis.crypto.randomUUID()}`;
  const other = `${key}.other`;

  it("reads back what it stores, verbatim", async () => {
    const value = JSON.stringify({ v: 1, note: "ünïcødé \u2028 line" });
    await storage.setItem(key, value);
    expect(await storage.getItem(key)).toBe(value);
    await storage.setItem(key, "replaced");
    expect(await storage.getItem(key)).toBe("replaced");
    await storage.removeItem(key);
  });

  it("answers null for a key it never stored or removed", async () => {
    expect(await storage.getItem(other)).toBeNull();
    await storage.setItem(key, "kept");
    await storage.removeItem(key);
    expect(await storage.getItem(key)).toBeNull();
    await storage.removeItem(other);
  });

  it("keeps keys apart", async () => {
    await storage.setItem(key, "a");
    await storage.setItem(other, "b");
    expect(await storage.getItem(key)).toBe("a");
    expect(await storage.getItem(other)).toBe("b");
    await storage.removeItem(key);
    expect(await storage.getItem(other)).toBe("b");
    await storage.removeItem(other);
  });
}
