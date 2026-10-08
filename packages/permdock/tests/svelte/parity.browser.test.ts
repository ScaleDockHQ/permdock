import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../../src/core/interfaces.ts";
import type { PermissionBoundaryState } from "../../src/svelte/runtime.ts";

import { tenantView } from "../../src/client/views.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { createSvelteStore } from "../../src/svelte/context.ts";
import { alice, policy as saasPolicy } from "../fixtures/saas.ts";
import BoundaryHarness from "./BoundaryHarness.test.svelte";
import { cell } from "./fixtures/cell.svelte.ts";

async function saasSnapshot(): Promise<Snapshot> {
  const server = await createPermDock(saasPolicy, alice, { tenant: "acme" });
  // SAFETY: snapshot() returns a Snapshot without a signer.
  return server.snapshot({ tenants: "all" }) as Snapshot;
}

describe("permdock/svelte parity", () => {
  it("PermissionBoundary renders denied or approval and retries", async () => {
    const digest = cell<string | null>("PERMDOCK_DENIED;post.publish");
    let latest: PermissionBoundaryState | undefined;
    const target = document.createElement("div");
    const app = mount(BoundaryHarness, {
      target,
      props: {
        digest: () => digest.value,
        onstate: (state: PermissionBoundaryState) => {
          latest = state;
        },
      },
    });
    flushSync();
    expect(target.textContent.trim()).toBe("denied post.publish");
    digest.value = "PERMDOCK_APPROVAL_REQUIRED;post.delete;tok";
    latest?.retry();
    flushSync();
    expect(target.textContent.trim()).toBe("approval tok");
    digest.value = null;
    latest?.retry();
    flushSync();
    expect(target.textContent.trim()).toBe("content");
    await unmount(app);
  });

  it("PermissionBoundary passes other errors to the next boundary", async () => {
    const target = document.createElement("div");
    const app = mount(BoundaryHarness, {
      target,
      props: {
        digest: () => {
          throw new Error("boom");
        },
        onstate: () => undefined,
      },
    });
    flushSync();
    expect(target.textContent.trim()).toBe("outer boom");
    await unmount(app);
  });

  it("reads headers on every refresh and switches tenant when the getter changes", async () => {
    const snapshot = await saasSnapshot();
    const token = cell("a");
    const tenant = cell("acme");
    const seen: (string | null)[] = [];
    const store = createSvelteStore({
      snapshot,
      endpoint: false,
      snapshotUrl: "/snap",
      headers: () => ({ authorization: token.value }),
      tenant: () => tenant.value,
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return Response.json(snapshot);
      },
    });
    await store.get().refresh();
    token.value = "b";
    await store.get().refresh();
    expect(seen).toEqual(["a", "b"]);
    expect(tenantView(store.get()).tenant).toBe("acme");
    tenant.value = "globex";
    flushSync();
    await vi.waitFor(() => {
      expect(tenantView(store.get()).tenant).toBe("globex");
    });
  });
});
