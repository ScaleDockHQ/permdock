import { describe, expect, it } from "vitest";

import { createClientStore } from "../../src/client/store.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { adminOf, policy } from "../fixtures/large-policy.ts";

describe("client store with a compact snapshot", () => {
  it("holds the expanded form of a compact snapshot", () => {
    const server = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const compact = server.snapshot();
    const expanded = server.snapshot({ v: 1 });
    if (compact instanceof Promise || expanded instanceof Promise) {
      throw new TypeError("expected unsigned snapshots");
    }
    const held = createClientStore({ snapshot: compact }).snapshot();
    expect(held.v).toBe(1);
    expect(held.grants).toStrictEqual(expanded.grants);
  });
});
