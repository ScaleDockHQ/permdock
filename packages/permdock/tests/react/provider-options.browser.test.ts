import { type ReactNode, act, createElement, use } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { TokenVerifier } from "../../src/core/interfaces.ts";
import type { ClientStore } from "../../src/react/store.ts";

import { emptySnapshot } from "../../src/core/from-snapshot.ts";
import { PermDockStoreContext } from "../../src/react/context.ts";
import { PermDockProvider } from "../../src/react/provider.tsx";

beforeAll(() => {
  // SAFETY: React reads this global flag to allow act() outside a test renderer.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
});

const snapshot = emptySnapshot();
const stores: ClientStore[] = [];

function Capture(): null {
  const store = use(PermDockStoreContext);
  if (store !== null) {
    stores.push(store);
  }
  return null;
}

function render(node: ReactNode): void {
  const current = (root ??= createRoot(document.createElement("div")));
  act(() => {
    current.render(node);
  });
}

function verifier(): TokenVerifier {
  return { verify: () => Promise.reject(new Error("unused")) };
}

function tree(props: {
  readonly headers?: Readonly<Record<string, string>>;
  readonly verifier?: TokenVerifier;
}): ReactNode {
  return createElement(PermDockProvider, {
    snapshot,
    endpoint: "/api/permdock",
    fetch: () => Promise.reject(new Error("offline")),
    ...props,
    children: createElement(Capture),
  });
}

describe("permdock/react PermDockProvider options", () => {
  it("keeps its store across re-renders with inline headers, fetch and verifier", () => {
    stores.length = 0;
    render(tree({ headers: { authorization: "a" }, verifier: verifier() }));
    render(tree({ headers: { authorization: "a" }, verifier: verifier() }));
    expect(new Set(stores).size).toBe(1);
  });

  it("rebuilds its store when a header value or the verifier's presence changes", () => {
    stores.length = 0;
    render(tree({ headers: { authorization: "a" } }));
    render(tree({ headers: { authorization: "b" } }));
    render(tree({ headers: { authorization: "b" }, verifier: verifier() }));
    expect(new Set(stores).size).toBe(3);
  });
});
