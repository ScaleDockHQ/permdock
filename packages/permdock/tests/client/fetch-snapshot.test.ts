import { describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/core/snapshot-types.ts";

import { createClientStore } from "../../src/client/store.ts";
import { emptySnapshot } from "../../src/core/from-snapshot.ts";

function signedIn(id: string, tenants: readonly string[] = []): Snapshot {
  return {
    ...emptySnapshot(),
    subject: { principal: { id, roles: [] }, context: {} },
    tenants,
  };
}

describe("fetchSnapshot", () => {
  it("answers refresh() without an endpoint", async () => {
    const asked: (string | undefined)[] = [];
    const store = createClientStore({
      snapshot: signedIn("u1"),
      server: false,
      fetchSnapshot: ({ tenant }) => {
        asked.push(tenant);
        return signedIn("u2");
      },
    });
    await store.get().refresh();
    expect(store.snapshot().subject.principal?.id).toBe("u2");
    expect(asked).toStrictEqual([undefined]);
  });

  it("passes the requested tenant when the snapshot does not list it", async () => {
    const asked: (string | undefined)[] = [];
    const store = createClientStore({
      snapshot: signedIn("u1", ["o1"]),
      server: false,
      fetchSnapshot: ({ tenant }) => {
        asked.push(tenant);
        return signedIn("u1", ["o1", "o2"]);
      },
    });
    await store.get().refresh({ tenant: "o2" });
    expect(asked).toStrictEqual(["o2"]);
    expect(store.tenant()).toBe("o2");
  });

  it("keeps the snapshot and marks it stale when the callback rejects", async () => {
    const store = createClientStore({
      snapshot: signedIn("u1"),
      server: false,
      fetchSnapshot: () => Promise.reject(new Error("down")),
    });
    await store.get().refresh();
    expect(store.snapshot().subject.principal?.id).toBe("u1");
    expect(store.get().status()).toBe("stale");
  });

  it("rejects an unsigned snapshot when a verifier is set", async () => {
    const store = createClientStore({
      snapshot: signedIn("u1"),
      server: false,
      verifier: {
        verify: () =>
          Promise.resolve({
            ok: false,
            reason: "invalid-token",
            cause: "invalid-signature",
          } as const),
      },
      fetchSnapshot: () => signedIn("u2"),
    });
    await store.get().refresh();
    expect(store.snapshot().subject.principal?.id).toBe("u1");
  });
});
