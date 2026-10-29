import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RefreshTrigger } from "../../src/client/refresh-on.ts";
import type { Snapshot } from "../../src/core/snapshot-types.ts";
import type { RealtimeRefreshChannel } from "../../src/supabase/client.ts";

import {
  authzChangeRefresh,
  broadcastChannelRefresh,
  focusRefresh,
  visibilityRefresh,
} from "../../src/client/refresh-on.ts";
import { createClientStore } from "../../src/client/store.ts";
import { emptySnapshot } from "../../src/core/from-snapshot.ts";
import { supabaseRealtimeRefresh } from "../../src/supabase/client.ts";

function signedIn(id: string): Snapshot {
  return {
    ...emptySnapshot(),
    subject: { principal: { id, roles: [] }, context: {} },
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

describe(focusRefresh, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires on window focus and stops listening on unsubscribe", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const refresh = vi.fn<() => void>();
    const off = focusRefresh()(refresh);
    target.dispatchEvent(new Event("focus"));
    off();
    target.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("never fires without a window", () => {
    const refresh = vi.fn<() => void>();
    focusRefresh()(refresh)();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe(visibilityRefresh, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires only when the document turns visible", () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("document", doc);
    const refresh = vi.fn<() => void>();
    const off = visibilityRefresh()(refresh);
    doc.dispatchEvent(new Event("visibilitychange"));
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    off();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe(broadcastChannelRefresh, () => {
  it("fires on a message from another channel object with the same name", async () => {
    const refresh = vi.fn<() => void>();
    const off = broadcastChannelRefresh("permdock-test")(refresh);
    const sender = new BroadcastChannel("permdock-test");
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage takes no target origin
    sender.postMessage("changed");
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledOnce();
    });
    sender.close();
    off();
  });
});

describe(authzChangeRefresh, () => {
  it("fires every subscribed trigger on notify and none after unsubscribe", () => {
    const authz = authzChangeRefresh();
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    const offFirst = authz.trigger(first);
    authz.trigger(second);
    authz.notify();
    offFirst();
    authz.notify();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(authz)).toBe(true);
  });
});

describe("store.refreshOn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes through added triggers, folds bursts and skips after clear()", async () => {
    const authz = authzChangeRefresh();
    const http = counted();
    const store = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot",
      fetch: http.fetch,
      server: false,
    });
    const off = store.refreshOn([authz.trigger]);
    authz.notify();
    authz.notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(http.calls()).toBe(1);
    store.get().clear();
    authz.notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(http.calls()).toBe(1);
    off();
  });

  it("adds nothing during a server render", () => {
    const trigger = vi.fn<RefreshTrigger>(() => () => undefined);
    const store = createClientStore({ snapshot: signedIn("u1"), server: true });
    store.refreshOn([trigger])();
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe(supabaseRealtimeRefresh, () => {
  it("joins the user's private authz topic, fires on the version event and removes the channel", () => {
    const handlers: (() => void)[] = [];
    const channel: RealtimeRefreshChannel & {
      readonly on: ReturnType<
        typeof vi.fn<
          (
            type: "broadcast",
            filter: { readonly event: string },
            callback: (message: unknown) => void,
          ) => unknown
        >
      >;
      readonly subscribe: ReturnType<typeof vi.fn<() => unknown>>;
    } = {
      on: vi.fn<
        (
          type: "broadcast",
          filter: { readonly event: string },
          callback: (message: unknown) => void,
        ) => unknown
      >((_type, _filter, callback): unknown => {
        handlers.push(() => {
          callback({ payload: { user_id: "u1", version: 2 } });
        });
        return undefined;
      }),
      subscribe: vi.fn<() => unknown>(),
    };
    const client = {
      channel: vi.fn<
        (
          topic: string,
          options: { readonly config: { readonly private: boolean } },
        ) => typeof channel
      >(() => channel),
      removeChannel: vi.fn<(removed: typeof channel) => unknown>(),
    };
    const refresh = vi.fn<() => void>();
    const off = supabaseRealtimeRefresh(client, { userId: "u1" })(refresh);
    expect(client.channel).toHaveBeenCalledWith("authz:u1", {
      config: { private: true },
    });
    expect(channel.on).toHaveBeenCalledWith(
      "broadcast",
      { event: "changed" },
      expect.any(Function),
    );
    expect(channel.subscribe).toHaveBeenCalledOnce();
    for (const handler of handlers) {
      handler();
    }
    expect(refresh).toHaveBeenCalledOnce();
    off();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });
});
