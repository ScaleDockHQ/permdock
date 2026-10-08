import { type ReactNode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  NativeRevalidate,
  SubscribeForeground,
  SubscribeOnline,
} from "../../src/react-native/types.ts";

import { emptySnapshot } from "../../src/core/from-snapshot.ts";
import { PermDockProvider } from "../../src/react-native/provider.tsx";
import { memoryStorage } from "../../src/react-native/storage.ts";
import { usePermDock } from "../../src/react/hooks.ts";

beforeAll(() => {
  // SAFETY: React reads this global flag to allow act() outside a test renderer.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  vi.useRealTimers();
});

function mount(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  const created = createRoot(host);
  root = created;
  act(() => {
    created.render(node);
  });
  return host;
}

function Probe(): string {
  return usePermDock().status();
}

function counter(): {
  readonly calls: () => number;
  readonly fetch: typeof fetch;
} {
  let count = 0;
  return {
    calls: () => count,
    fetch: async () => {
      count += 1;
      return new Response(JSON.stringify(emptySnapshot()));
    },
  };
}

function provider(
  revalidate: NativeRevalidate | undefined,
  extra: {
    readonly fetch: typeof fetch;
    readonly snapshotUrl?: string;
    readonly subscribeForeground?: SubscribeForeground;
    readonly subscribeOnline?: SubscribeOnline;
  },
): ReactNode {
  return createElement(PermDockProvider, {
    storage: memoryStorage(),
    subjectId: null,
    snapshot: emptySnapshot(),
    ...(revalidate === undefined ? {} : { revalidate }),
    ...extra,
    children: createElement(Probe),
  });
}

describe("permdock/react-native PermDockProvider revalidation", () => {
  it("refreshes once on launch by default", async () => {
    const net = counter();
    mount(provider(undefined, { fetch: net.fetch, snapshotUrl: "/snap" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(net.calls()).toBe(1);
  });

  it("never refreshes without a snapshot URL", async () => {
    const net = counter();
    mount(provider("launch", { fetch: net.fetch }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(net.calls()).toBe(0);
  });

  it("refreshes on an interval in seconds and stops on unmount", async () => {
    const net = counter();
    mount(provider(5, { fetch: net.fetch, snapshotUrl: "/snap" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(net.calls()).toBe(3);
    act(() => {
      root?.unmount();
    });
    root = undefined;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(net.calls()).toBe(3);
  });

  it("refreshes on each foreground event and unsubscribes on unmount", async () => {
    const net = counter();
    let foreground: ((active?: boolean) => void) | undefined;
    const unsubscribe = vi.fn<() => void>();
    mount(
      provider("focus", {
        fetch: net.fetch,
        snapshotUrl: "/snap",
        subscribeForeground: (listener) => {
          foreground = listener;
          return unsubscribe;
        },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      foreground?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(net.calls()).toBe(2);
    act(() => {
      root?.unmount();
    });
    root = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("refreshes once on focus mode without a foreground source", async () => {
    const net = counter();
    mount(provider("focus", { fetch: net.fetch, snapshotUrl: "/snap" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(net.calls()).toBe(1);
  });

  it("keeps its store across new inline headers and fetch, and sends the latest token", async () => {
    const first = counter();
    const second = counter();
    const storage = memoryStorage();
    const snapshot = emptySnapshot();
    const tokens: (string | null)[] = [];
    const tree = (net: typeof first, token: string): ReactNode =>
      createElement(PermDockProvider, {
        storage,
        subjectId: null,
        snapshot,
        snapshotUrl: "/snap",
        revalidate: 5,
        headers: { authorization: token },
        fetch: (input, init) => {
          tokens.push(new Headers(init?.headers).get("authorization"));
          return net.fetch(input, init);
        },
        children: createElement(Probe),
      });
    mount(tree(first, "a"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      root?.render(tree(second, "a"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect([first.calls(), second.calls()]).toEqual([1, 1]);
    act(() => {
      root?.render(tree(second, "b"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(second.calls()).toBe(2);
    expect(tokens).toEqual(["a", "a", "b"]);
  });

  it("pauses the interval in the background and refreshes on return", async () => {
    const net = counter();
    let foreground: ((active?: boolean) => void) | undefined;
    mount(
      provider(5, {
        fetch: net.fetch,
        snapshotUrl: "/snap",
        subscribeForeground: (listener) => {
          foreground = listener;
          return () => undefined;
        },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      foreground?.(false);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(net.calls()).toBe(1);
    await act(async () => {
      foreground?.(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(net.calls()).toBe(2);
  });

  it("skips refreshes while offline and refreshes on reconnect", async () => {
    const net = counter();
    let online: ((next: boolean) => void) | undefined;
    let foreground: ((active?: boolean) => void) | undefined;
    mount(
      provider("focus", {
        fetch: net.fetch,
        snapshotUrl: "/snap",
        subscribeForeground: (listener) => {
          foreground = listener;
          return () => undefined;
        },
        subscribeOnline: (listener) => {
          online = listener;
          return () => undefined;
        },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      online?.(false);
      foreground?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(net.calls()).toBe(1);
    await act(async () => {
      online?.(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(net.calls()).toBe(2);
  });

  it("runs one refresh at a time", async () => {
    let calls = 0;
    let foreground: ((active?: boolean) => void) | undefined;
    mount(
      provider("focus", {
        snapshotUrl: "/snap",
        fetch: () => {
          calls += 1;
          return new Promise<Response>(() => {
            // never settles
          });
        },
        subscribeForeground: (listener) => {
          foreground = listener;
          return () => undefined;
        },
      }),
    );
    await act(async () => {
      foreground?.();
      foreground?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(1);
  });

  it("marks the snapshot stale when the launch refresh fails", async () => {
    const host = mount(
      provider("launch", {
        snapshotUrl: "/snap",
        fetch: () => Promise.reject(new Error("offline")),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.textContent).toBe("stale");
  });
});
