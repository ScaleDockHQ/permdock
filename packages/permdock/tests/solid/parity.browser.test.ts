import {
  createComponent,
  createSignal,
  ErrorBoundary,
  type JSX,
} from "solid-js";
import { render } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../../src/core/interfaces.ts";

import { createPermDock } from "../../src/core/permdock.ts";
import { PermissionBoundary } from "../../src/solid/boundary.ts";
import { usePermDock, useTenant } from "../../src/solid/hooks.ts";
import { PermDockProvider } from "../../src/solid/provider.ts";
import { alice, policy as saasPolicy } from "../fixtures/saas.ts";

function refused(digest: string): Error {
  return Object.assign(new Error("refused"), { digest });
}

function Thrower(props: { readonly digest: () => string | null }): JSX.Element {
  const digest = props.digest();
  if (digest !== null) {
    throw refused(digest);
  }
  // SAFETY: Solid renders a string child as text.
  return "content" as unknown as JSX.Element;
}

describe("permdock/solid parity", () => {
  it("PermissionBoundary renders denied or approval and retries", () => {
    const [digest, setDigest] = createSignal<string | null>(
      "PERMDOCK_DENIED;post.publish",
    );
    let retry: (() => void) | undefined;
    const root = document.createElement("div");
    const dispose = render(
      () =>
        createComponent(PermissionBoundary, {
          denied: (state) => {
            retry = state.retry;
            return `denied ${state.permission}`;
          },
          approval: (state) =>
            state.outcome === "approval-required"
              ? `approval ${state.token}`
              : "",
          get children() {
            return createComponent(Thrower, { digest });
          },
        }),
      root,
    );
    expect(root.textContent).toBe("denied post.publish");
    setDigest("PERMDOCK_APPROVAL_REQUIRED;post.delete;tok");
    retry?.();
    expect(root.textContent).toBe("approval tok");
    setDigest(null);
    retry?.();
    expect(root.textContent).toBe("content");
    dispose();
  });

  it("PermissionBoundary passes other errors to the next boundary", () => {
    const root = document.createElement("div");
    const dispose = render(
      () =>
        createComponent(ErrorBoundary, {
          fallback: (error: unknown) =>
            `outer ${error instanceof Error ? error.message : ""}`,
          get children() {
            return createComponent(PermissionBoundary, {
              denied: "denied",
              get children() {
                return createComponent(Thrower, {
                  digest: () => {
                    throw new Error("boom");
                  },
                });
              },
            });
          },
        }),
      root,
    );
    expect(root.textContent).toBe("outer boom");
    dispose();
  });

  it("reads headers on every refresh and switches tenant when the prop changes", async () => {
    const server = await createPermDock(saasPolicy, alice, { tenant: "acme" });
    // SAFETY: snapshot() returns a Snapshot without a signer.
    const snapshot = server.snapshot({ tenants: "all" }) as Snapshot;
    const [token, setToken] = createSignal("a");
    const [tenant, setTenant] = createSignal("acme");
    const seen: (string | null)[] = [];
    let permdock: ReturnType<typeof usePermDock> | undefined;
    let view: ReturnType<typeof useTenant> | undefined;
    const dispose = render(
      () =>
        createComponent(PermDockProvider, {
          snapshot,
          endpoint: false,
          snapshotUrl: "/snap",
          get headers() {
            return { authorization: token() };
          },
          get tenant() {
            return tenant();
          },
          fetch: async (_input, init) => {
            seen.push(new Headers(init?.headers).get("authorization"));
            return Response.json(snapshot);
          },
          get children() {
            permdock = usePermDock();
            view = useTenant();
            return null;
          },
        }),
      document.createElement("div"),
    );
    await permdock?.refresh();
    setToken("b");
    await permdock?.refresh();
    expect(seen).toEqual(["a", "b"]);
    expect(view?.().tenant).toBe("acme");
    setTenant("globex");
    await vi.waitFor(() => {
      expect(view?.().tenant).toBe("globex");
    });
    dispose();
  });
});
