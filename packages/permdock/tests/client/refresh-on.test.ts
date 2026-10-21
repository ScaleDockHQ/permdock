import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RefreshTrigger } from "../../src/client/refresh-on.ts";
import type { Snapshot } from "../../src/core/snapshot-types.ts";

import { eventSourceRefresh } from "../../src/client/refresh-on.ts";
import { createClientStore } from "../../src/client/store.ts";
import { emptySnapshot } from "../../src/core/from-snapshot.ts";

function signedIn(id: string): Snapshot {
  return {
    ...emptySnapshot(),
    subject: { principal: { id, roles: [] }, context: {} },
  };
}

function manual(): {
  readonly trigger: RefreshTrigger;
  readonly fire: () => void;
  readonly active: () => number;
} {
  const listeners = new Set<() => void>();
  return {
    trigger: (refresh) => {
      listeners.add(refresh);
      return () => {
        listeners.delete(refresh);
      };
    },
    fire: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    active: () => listeners.size,
  };
}

function counted(): {
  readonly fetch: typeof fetch;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify(signedIn("u1")), {
          headers: { "content-type": "application/json" },
        }),
      );
    },
    calls: () => calls,
  };
}

describe("refreshOn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with the first subscriber, folds bursts into one refresh and stops with the last", async () => {
    const source = manual();
    const http = counted();
    const store = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot",
      fetch: http.fetch,
      server: false,
      refreshOn: [source.trigger],
    });
    expect(source.active()).toBe(0);
    const off = store.subscribe(() => undefined);
    expect(source.active()).toBe(1);
    source.fire();
    source.fire();
    source.fire();
    await vi.advanceTimersByTimeAsync(300);
    expect(http.calls()).toBe(1);
    off();
    expect(source.active()).toBe(0);
  });

  it("drops a pending refresh after clear() and never starts during a server render", async () => {
    const source = manual();
    const http = counted();
    const store = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot",
      fetch: http.fetch,
      server: false,
      refreshOn: [source.trigger],
    });
    store.subscribe(() => undefined);
    source.fire();
    store.get().clear();
    source.fire();
    await vi.advanceTimersByTimeAsync(300);
    expect(http.calls()).toBe(0);

    const rendered = manual();
    const server = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot",
      fetch: http.fetch,
      server: true,
      refreshOn: [rendered.trigger],
    });
    server.subscribe(() => undefined);
    expect(rendered.active()).toBe(0);
  });

  it("cancels a pending refresh when the last subscriber leaves", async () => {
    const source = manual();
    const http = counted();
    const store = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot",
      fetch: http.fetch,
      server: false,
      refreshOn: [source.trigger],
    });
    const off = store.subscribe(() => undefined);
    source.fire();
    off();
    await vi.advanceTimersByTimeAsync(300);
    expect(http.calls()).toBe(0);
  });

  it("drops a refresh when clear() lands before the delay ends", async () => {
    const source = manual();
    const http = counted();
    const store = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot",
      fetch: http.fetch,
      server: false,
      refreshOn: [source.trigger],
    });
    store.subscribe(() => undefined);
    source.fire();
    await vi.advanceTimersByTimeAsync(100);
    store.get().clear();
    await vi.advanceTimersByTimeAsync(300);
    expect(http.calls()).toBe(0);
  });

  it("stops every trigger on dispose()", () => {
    const source = manual();
    const store = createClientStore({
      snapshot: signedIn("u1"),
      server: false,
      refreshOn: [source.trigger],
    });
    store.subscribe(() => undefined);
    store.dispose();
    expect(source.active()).toBe(0);
  });
});

class FakeEventSource extends EventTarget {
  public static last: FakeEventSource | undefined;
  public readonly url: string;
  public closed = false;
  public constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.last = this;
  }
  public close(): void {
    this.closed = true;
  }
  public emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe(eventSourceRefresh, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes on a matching CloudEvent type and ignores the rest", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const refresh = vi.fn<() => void>();
    const off = eventSourceRefresh("/api/events")(refresh);
    const source = FakeEventSource.last;
    source?.emit(
      JSON.stringify({ type: "com.permdock.membership.added", id: "1" }),
    );
    source?.emit(JSON.stringify({ type: "com.permdock.catalog.published" }));
    source?.emit(JSON.stringify({ type: "com.permdock.decision.made" }));
    source?.emit("not json");
    source?.emit("42");
    source?.emit({ type: "com.permdock.membership.added" });
    expect(refresh).toHaveBeenCalledTimes(2);
    off();
    expect(source?.closed).toBe(true);
  });

  it("matches exact types and prefixes from types", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const refresh = vi.fn<() => void>();
    eventSourceRefresh("/api/events", {
      types: ["com.example.role.changed", "com.example.team.*"],
    })(refresh);
    const source = FakeEventSource.last;
    source?.emit(JSON.stringify({ type: "com.example.role.changed" }));
    source?.emit(JSON.stringify({ type: "com.example.team.joined" }));
    source?.emit(JSON.stringify({ type: "com.permdock.membership.added" }));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("never fires without a global EventSource", () => {
    vi.stubGlobal("EventSource", undefined);
    const refresh = vi.fn<() => void>();
    const off = eventSourceRefresh("/api/events")(refresh);
    off();
    expect(refresh).not.toHaveBeenCalled();
  });
});
