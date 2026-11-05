import type * as React from "react";
import type { ReactElement } from "react";
import type * as ReactDomClient from "react-dom/client";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../../src/core/snapshot-types.ts";
import type * as Entry from "../../src/react/index.ts";

import { getPermDockSync } from "../../src/core/permdock.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

function memberSnapshot(): Snapshot {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const snapshot = getPermDockSync(policy as never, memberUser).snapshot({
    v: 1,
  });
  if (snapshot instanceof Promise) {
    throw new TypeError("expected JSON snapshot");
  }
  return snapshot;
}

function setActEnvironment(value: boolean): void {
  // SAFETY: React reads this global flag to allow act() outside a test renderer.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = value;
}

const settled =
  "true:ready:1,ready:true,ready:approval-required,ready:true|yes";

type Loaded = {
  readonly react: typeof React;
  readonly dom: typeof ReactDomClient;
  readonly entry: typeof Entry;
};

async function fresh(lazy: boolean): Promise<Loaded> {
  vi.resetModules();
  return {
    react: await import("react"),
    dom: await import("react-dom/client"),
    entry: lazy
      ? await import("../../src/react/lazy.ts")
      : await import("../../src/react/index.ts"),
  };
}

function tree(
  { react, entry }: Loaded,
  props: {
    readonly snapshot?: Snapshot;
    readonly snapshotPromise?: PromiseLike<Snapshot>;
    readonly suspend?: boolean;
  },
): ReactElement {
  const { createElement, Suspense } = react;
  function Probe(): string {
    const permdock = entry.usePermDock();
    const editable = entry.useFilter(permissions.post.update, [ownPost]);
    const row = entry.usePermission(permissions.post.update, ownPost);
    const decision = entry.useDecision(permissions.post.delete, ownPost);
    const quick = entry.usePermission(permissions.post.read);
    return [
      `${String(permdock.can(permissions.post.update, ownPost))}:${permdock.status(permissions.post.update, ownPost)}:${String(editable.length)}`,
      `${row.status}:${String(row.allowed)}`,
      `${decision.status}:${decision.decision.outcome}`,
      `${quick.status}:${String(quick.allowed)}`,
    ].join(",");
  }
  return createElement(
    Suspense,
    { fallback: "fallback" },
    createElement(entry.PermDockProvider, {
      ...(props.snapshotPromise === undefined
        ? { snapshot: props.snapshot ?? memberSnapshot() }
        : { snapshotPromise: props.snapshotPromise }),
      endpoint: false,
      suspend: props.suspend === true,
      children: [
        createElement(Probe, { key: "probe" }),
        createElement(entry.Protected, {
          key: "guard",
          permission: permissions.post.update,
          data: ownPost,
          pending: "|wait",
          children: "|yes",
        }),
      ],
    }),
  );
}

describe("permdock/react and permdock/react/lazy", () => {
  const hosts: (() => void)[] = [];

  function host(): HTMLElement {
    const element = document.createElement("div");
    document.body.append(element);
    hosts.push(() => element.remove());
    return element;
  }

  afterEach(() => {
    setActEnvironment(false);
    for (const cleanup of hosts.splice(0)) {
      cleanup();
    }
    vi.restoreAllMocks();
  });

  it("answers every check on the first render with a synchronous snapshot", async () => {
    setActEnvironment(true);
    const errors = vi.spyOn(console, "error");
    const loaded = await fresh(false);
    const element = host();
    const root = loaded.dom.createRoot(element);
    loaded.react.act(() => {
      root.render(tree(loaded, {}));
    });
    expect(element.textContent).toBe(settled);
    expect(errors).not.toHaveBeenCalled();
    loaded.react.act(() => {
      root.unmount();
    });
  });

  it("renders the answers on the server and hydrates them without a mismatch", async () => {
    const server = await fresh(false);
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(tree(server, {}));
    expect(html.replaceAll(/<!--.*?-->/gu, "")).toBe(settled);
    const client = await fresh(false);
    const element = host();
    element.innerHTML = html;
    const recoverable = vi.fn<(error: unknown) => void>();
    const root = client.dom.hydrateRoot(element, tree(client, {}), {
      onRecoverableError: recoverable,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(element.innerHTML).toBe(html);
    root.unmount();
  });

  it("suspends readers of a snapshot promise only with suspend", async () => {
    setActEnvironment(true);
    const loaded = await fresh(false);
    const element = host();
    const root = loaded.dom.createRoot(element);
    const pending = Promise.withResolvers<Snapshot>();
    loaded.react.act(() => {
      root.render(tree(loaded, { snapshotPromise: pending.promise }));
    });
    expect(element.textContent).toBe(
      "false:pending:0,pending:false,pending:denied,pending:false|wait",
    );
    loaded.react.act(() => {
      root.unmount();
    });
    setActEnvironment(false);
    const waiting = Promise.withResolvers<Snapshot>();
    const suspended = loaded.dom.createRoot(element);
    suspended.render(
      tree(loaded, { snapshotPromise: waiting.promise, suspend: true }),
    );
    await vi.waitFor(() => {
      expect(element.textContent).toBe("fallback");
    });
    waiting.resolve(memberSnapshot());
    await vi.waitFor(
      () => {
        expect(element.textContent).toBe(settled);
      },
      { timeout: 2000 },
    );
    suspended.unmount();
  });

  it("suspends the lazy entry until its evaluator loads, never rendering a stand-in", async () => {
    const loaded = await fresh(true);
    const element = host();
    const seen = new Set<string>();
    const observer = new MutationObserver(() => {
      seen.add(element.textContent);
    });
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const root = loaded.dom.createRoot(element);
    root.render(tree(loaded, {}));
    await vi.waitFor(() => {
      expect(element.textContent).toBe("fallback");
    });
    await vi.waitFor(
      () => {
        expect(element.textContent).toBe(settled);
      },
      { timeout: 2000 },
    );
    observer.disconnect();
    expect([...seen].filter((text) => text !== "")).toStrictEqual([
      "fallback",
      settled,
    ]);
    root.unmount();
  });

  it("hydrates the lazy entry's server markup while its chunk loads", async () => {
    const server = await fresh(false);
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(tree(server, {}));
    const client = await fresh(true);
    const element = host();
    element.innerHTML = html;
    const recoverable = vi.fn<(error: unknown) => void>();
    const root = client.dom.hydrateRoot(element, tree(client, {}), {
      onRecoverableError: recoverable,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(element.innerHTML).toBe(html);
    root.unmount();
  });
});
