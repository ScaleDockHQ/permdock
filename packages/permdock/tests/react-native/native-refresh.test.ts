import { describe, expect, it } from "vitest";

import type { LocalSnapshotManifest } from "../../src/core/snapshot-types.ts";
import type {
  NativeRefreshDatabase,
  NativeRefreshSupabase,
} from "../../src/react-native/native-refresh.ts";
import type {
  AppStateModule,
  NetInfoModule,
} from "../../src/react-native/subscriptions.ts";

import { nativeRefresh } from "../../src/react-native/native-refresh.ts";

function token(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `e30.${body}.sig`;
}

type Channel = {
  readonly topic: string;
  readonly on: (
    type: "broadcast",
    filter: { readonly event: string },
    callback: (message: unknown) => void,
  ) => Channel;
  readonly subscribe: () => Channel;
  send: () => void;
  removed: boolean;
};

function fakeSupabase(state: { version: number; user: string | null }): {
  readonly client: NativeRefreshSupabase<Channel>;
  readonly channels: Channel[];
  readonly log: string[];
} {
  const channels: Channel[] = [];
  const log: string[] = [];
  const client: NativeRefreshSupabase<Channel> = {
    channel: (topic) => {
      const channel: Channel = {
        topic,
        on: (_type, filter, callback) => {
          channel.send = (): void => {
            if (filter.event === "changed") {
              callback({});
            }
          };
          return channel;
        },
        subscribe: () => channel,
        send: () => undefined,
        removed: false,
      };
      channels.push(channel);
      return channel;
    },
    removeChannel: (channel) => {
      channel.removed = true;
    },
    auth: {
      getSession: async () => ({
        data: {
          session:
            state.user === null
              ? null
              : {
                  access_token: token({ authz_ver: state.version }),
                  user: { id: state.user },
                },
        },
      }),
      refreshSession: async () => {
        log.push("refreshSession");
      },
    },
  };
  return { client, channels, log };
}

function fakeAppState(): AppStateModule & {
  readonly emit: (state: string) => void;
} {
  const listeners = new Set<(state: string) => void>();
  return {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (state) => {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

function fakeNetInfo(): NetInfoModule & {
  readonly emit: (connected: boolean) => void;
} {
  const listeners = new Set<
    (state: { readonly isConnected: boolean | null }) => void
  >();
  return {
    addEventListener: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (connected) => {
      for (const listener of listeners) {
        listener({ isConnected: connected });
      }
    },
  };
}

function fakeDb(
  log: string[],
  versions: { value: number },
): NativeRefreshDatabase<"connector"> & {
  readonly change: () => void;
  readonly aborted: () => boolean;
} {
  const watchers = new Set<() => void>();
  let aborted = false;
  return {
    connect: async (connector) => {
      log.push(`connect:${connector}`);
    },
    disconnect: async () => {
      log.push("disconnect");
    },
    getAll: async (_sql, parameters) => [
      { version: versions.value, user: parameters?.[0] },
    ],
    watch: (_sql, _parameters, handler, options) => {
      const notify = (): void => {
        handler.onResult({});
      };
      watchers.add(notify);
      notify();
      options.signal.addEventListener("abort", () => {
        aborted = true;
        watchers.delete(notify);
      });
    },
    change: () => {
      for (const watcher of watchers) {
        watcher();
      }
    },
    aborted: () => aborted,
  };
}

const manifest = {
  v: 1,
  roles: [],
  grants: [],
  custom: {},
  rows: {
    memberships: [],
    version: {
      table: "permdock_authz_version",
      user: "user_id",
      version: "version",
    },
  },
} satisfies LocalSnapshotManifest;

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe(nativeRefresh, () => {
  it("refreshes the session, reconnects PowerSync, then refreshes on an authz message", async () => {
    const state = { version: 1, user: "u1" };
    const { client, channels, log } = fakeSupabase(state);
    const db = fakeDb(log, { value: 1 });
    const trigger = nativeRefresh({
      supabase: client,
      appState: fakeAppState(),
      powersync: { db, connector: "connector" },
    });
    const off = trigger(() => {
      log.push("refresh");
    });
    await settle();
    expect(channels.map((channel) => channel.topic)).toStrictEqual([
      "authz:u1",
    ]);
    channels[0]?.send();
    await settle();
    expect(log).toStrictEqual([
      "refreshSession",
      "disconnect",
      "connect:connector",
      "refresh",
    ]);
    off();
    expect(channels[0]?.removed).toBe(true);
  });

  it("folds signals during a pass into one more pass", async () => {
    const { client, channels, log } = fakeSupabase({ version: 1, user: "u1" });
    const off = nativeRefresh({ supabase: client, appState: fakeAppState() })(
      () => {
        log.push("refresh");
      },
    );
    await settle();
    channels[0]?.send();
    channels[0]?.send();
    channels[0]?.send();
    await settle();
    expect(log).toStrictEqual([
      "refreshSession",
      "refresh",
      "refreshSession",
      "refresh",
    ]);
    off();
  });

  it("holds a signal while offline and runs it once on reconnect", async () => {
    const { client, channels, log } = fakeSupabase({ version: 1, user: "u1" });
    const netInfo = fakeNetInfo();
    const off = nativeRefresh({
      supabase: client,
      appState: fakeAppState(),
      netInfo,
    })(() => {
      log.push("refresh");
    });
    await settle();
    netInfo.emit(false);
    channels[0]?.send();
    channels[0]?.send();
    await settle();
    expect(log).toStrictEqual([]);
    netInfo.emit(true);
    await settle();
    expect(log).toStrictEqual(["refreshSession", "refresh"]);
    off();
  });

  it("leaves the topic in the background and rejoins with a catch-up pass", async () => {
    const { client, channels, log } = fakeSupabase({ version: 1, user: "u1" });
    const appState = fakeAppState();
    const off = nativeRefresh({ supabase: client, appState })(() => {
      log.push("refresh");
    });
    await settle();
    appState.emit("background");
    expect(channels[0]?.removed).toBe(true);
    appState.emit("inactive");
    appState.emit("active");
    await settle();
    expect(channels).toHaveLength(2);
    expect(channels[1]?.removed).toBe(false);
    expect(log).toStrictEqual(["refreshSession", "refresh"]);
    off();
    expect(channels[1]?.removed).toBe(true);
  });

  it("runs a pass when the synced version passes the token's", async () => {
    const state = { version: 3, user: "u1" };
    const { client, log } = fakeSupabase(state);
    const versions = { value: 3 };
    const db = fakeDb(log, versions);
    const appState = fakeAppState();
    const off = nativeRefresh({
      supabase: client,
      appState,
      powersync: { db, connector: "connector", manifest },
    })(() => {
      log.push("refresh");
    });
    await settle();
    expect(log).toStrictEqual([]);
    versions.value = 4;
    db.change();
    await settle();
    expect(log).toStrictEqual([
      "refreshSession",
      "disconnect",
      "connect:connector",
      "refresh",
    ]);
    state.version = 4;
    log.length = 0;
    appState.emit("background");
    appState.emit("active");
    await settle();
    expect(log).toStrictEqual([]);
    off();
    expect(db.aborted()).toBe(true);
  });

  it("joins no topic without a session", async () => {
    const { client, channels, log } = fakeSupabase({ version: 1, user: null });
    const off = nativeRefresh({ supabase: client, appState: fakeAppState() })(
      () => {
        log.push("refresh");
      },
    );
    await settle();
    expect(channels).toStrictEqual([]);
    off();
  });

  it("still refreshes when the session refresh fails", async () => {
    const { client, channels, log } = fakeSupabase({ version: 1, user: "u1" });
    const failing: NativeRefreshSupabase<Channel> = {
      ...client,
      auth: {
        ...client.auth,
        refreshSession: async () => {
          throw new Error("offline");
        },
      },
    };
    const off = nativeRefresh({ supabase: failing, appState: fakeAppState() })(
      () => {
        log.push("refresh");
      },
    );
    await settle();
    channels[0]?.send();
    await settle();
    expect(log).toStrictEqual(["refresh"]);
    off();
    channels[0]?.send();
    await settle();
    expect(log).toStrictEqual(["refresh"]);
  });
});
