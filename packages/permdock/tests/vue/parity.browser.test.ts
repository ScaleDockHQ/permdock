import { describe, expect, it, vi } from "vitest";
import {
  createApp,
  defineComponent,
  effectScope,
  h,
  nextTick,
  shallowRef,
} from "vue";

import type { Snapshot } from "../../src/core/interfaces.ts";

import { createPermDock } from "../../src/core/permdock.ts";
import { PermissionBoundary } from "../../src/vue/boundary.ts";
import {
  useAssignablePermissions,
  usePermDock,
  usePermission,
} from "../../src/vue/composables.ts";
import { permdockPlugin } from "../../src/vue/plugin.ts";
import { Protected } from "../../src/vue/protected.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

async function memberSnapshot(): Promise<Snapshot> {
  // SAFETY: memberUser is a quick-start user fixture; only the policy generic is erased.
  const server = await createPermDock(policy as never, memberUser);
  // SAFETY: snapshot() returns a Snapshot; the erased generic above hides its type.
  return server.snapshot() as Snapshot;
}

function refused(digest: string): Error {
  return Object.assign(new Error("refused"), { digest });
}

describe("permdock/vue parity", () => {
  it("PermissionBoundary renders denied or approval and retries", async () => {
    const fail = shallowRef<string | null>("PERMDOCK_DENIED;post.publish");
    const Child = defineComponent({
      setup() {
        if (fail.value !== null) {
          throw refused(fail.value);
        }
        return () => h("b", "content");
      },
    });
    const root = document.createElement("div");
    const app = createApp({
      render: () =>
        h(PermissionBoundary, null, {
          default: () => h(Child),
          denied: (state: { permission: string; retry: () => void }) =>
            h("button", { onClick: state.retry }, `denied ${state.permission}`),
          approval: (state: { token: string }) =>
            h("i", `approval ${state.token}`),
        }),
    });
    app.mount(root);
    await nextTick();
    expect(root.textContent).toBe("denied post.publish");
    fail.value = null;
    root.querySelector("button")?.click();
    await nextTick();
    expect(root.textContent).toBe("content");
    app.unmount();

    fail.value = "PERMDOCK_APPROVAL_REQUIRED;post.delete;tok";
    const second = document.createElement("div");
    const again = createApp({
      render: () =>
        h(PermissionBoundary, null, {
          default: () => h(Child),
          approval: (state: { token: string }) =>
            h("i", `approval ${state.token}`),
        }),
    });
    again.mount(second);
    await nextTick();
    expect(second.textContent).toBe("approval tok");
    again.unmount();
  });

  it("PermissionBoundary lets other errors propagate", async () => {
    const Child = defineComponent({
      setup() {
        throw new Error("boom");
      },
    });
    const handler = vi.fn<(error: unknown) => void>();
    const app = createApp({
      render: () =>
        h(PermissionBoundary, null, {
          default: () => h(Child),
          denied: () => h("i", "denied"),
        }),
    });
    app.config.errorHandler = handler;
    app.mount(document.createElement("div"));
    await nextTick();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
      expect.anything(),
      expect.any(String),
    );
    app.unmount();
  });

  it("denies server-only checks with endpoint false and reads headers on each refresh", async () => {
    const token = shallowRef("a");
    const seen: (string | null)[] = [];
    const snapshot = await memberSnapshot();
    let permdock: ReturnType<typeof usePermDock> | undefined;
    const app = createApp(
      defineComponent({
        setup() {
          permdock = usePermDock();
          return () => null;
        },
      }),
    );
    app.use(permdockPlugin, {
      snapshot,
      endpoint: false,
      snapshotUrl: "/snap",
      headers: () => ({ authorization: token.value }),
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return Response.json(snapshot);
      },
    });
    app.mount(document.createElement("div"));
    await permdock?.refresh();
    token.value = "b";
    await permdock?.refresh();
    expect(seen).toEqual(["a", "b"]);
    app.unmount();
  });

  it("<Protected data> accepts a primitive row", async () => {
    const root = document.createElement("div");
    const app = createApp({
      render: () =>
        h(
          Protected,
          { permission: permissions.post.read, data: "p1" },
          { default: () => h("b", "granted"), fallback: () => h("i", "no") },
        ),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    app.use(permdockPlugin, { snapshot: await memberSnapshot() });
    app.mount(root);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(root.textContent).toBe("granted");
    app.unmount();
  });

  it("throws outside a scope and takes a getter for assignable permissions", async () => {
    const app = createApp({ render: () => null });
    app.use(permdockPlugin, { snapshot: await memberSnapshot() });
    expect(() =>
      app.runWithContext(() => usePermission(permissions.post.read)),
    ).toThrow("PermDock: call composables in setup() or an effectScope");
    const tenant = shallowRef<string | undefined>(undefined);
    const scope = effectScope();
    const list = scope.run(() =>
      app.runWithContext(() =>
        useAssignablePermissions(() =>
          tenant.value === undefined ? {} : { tenant: tenant.value },
        ),
      ),
    );
    expect(Array.isArray(list?.value)).toBe(true);
    scope.stop();
  });
});
