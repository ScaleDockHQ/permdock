import type { RefreshTrigger } from "../client/refresh-on.ts";
import type { LocalSnapshotManifest } from "../core/snapshot-types.ts";
import type {
  RealtimeRefreshChannel,
  RealtimeRefreshClient,
} from "../supabase/client.ts";
import type {
  PowerSyncSnapshotSource,
  PowerSyncWatchable,
} from "./powersync.ts";
import type { AppStateModule, NetInfoModule } from "./subscriptions.ts";

import { isRecord } from "../core/compact.ts";
import { AUTHZ_EVENT, authzUserTopic } from "../supabase/authz-topic.ts";
import { authzVersionQuery, highestVersion } from "./powersync.ts";
import { appStateForeground, netInfoOnline } from "./subscriptions.ts";

/** The part of a supabase-js session `nativeRefresh` reads. */
export type NativeRefreshSession = {
  readonly access_token: string;
  readonly user: { readonly id: string };
};

/** The part of a React Native supabase-js client `nativeRefresh` uses. */
export type NativeRefreshSupabase<
  C extends RealtimeRefreshChannel = RealtimeRefreshChannel,
> = RealtimeRefreshClient<C> & {
  readonly auth: {
    readonly getSession: () => Promise<{
      readonly data: { readonly session: NativeRefreshSession | null };
    }>;
    readonly refreshSession: () => Promise<unknown>;
  };
};

/** The `PowerSyncDatabase` methods `nativeRefresh` calls. */
export type NativeRefreshDatabase<K> = PowerSyncWatchable & {
  readonly connect: (connector: K) => Promise<void>;
  readonly disconnect: () => Promise<void>;
};

export type NativeRefreshPowerSync<K> = {
  readonly db: NativeRefreshDatabase<K>;
  /** The connector the app connects with; a reconnect fetches a new token. */
  readonly connector: K;
  /**
   * The manifest `permdock powersync generate` writes. With its `rows.version`,
   * a synced version above the token's `authz_ver` runs a refresh, which covers
   * a message sent while the app was closed.
   */
  readonly manifest?: LocalSnapshotManifest;
  /**
   * The `powerSyncSource` the provider reads. Its `authzVersion()` answers the
   * synced version for the foreground catch-up, in place of a query built from
   * `manifest`.
   */
  readonly source?: Pick<PowerSyncSnapshotSource, "authzVersion">;
};

export type NativeRefreshOptions<
  C extends RealtimeRefreshChannel = RealtimeRefreshChannel,
  K = unknown,
> = {
  readonly supabase: NativeRefreshSupabase<C>;
  /** The `AppState` export of `react-native`. */
  readonly appState: AppStateModule;
  /**
   * The default export of `@react-native-community/netinfo`. A signal that
   * arrives offline waits for the connection, then runs once.
   */
  readonly netInfo?: NetInfoModule;
  /** Reconnects PowerSync after the session refresh. */
  readonly powersync?: NativeRefreshPowerSync<K>;
};

/** The `authz_ver` claim of an access token, read without verifying it. */
function tokenVersion(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const claims: unknown = JSON.parse(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    );
    const version = isRecord(claims) ? claims["authz_ver"] : undefined;
    return typeof version === "number" &&
      Number.isSafeInteger(version) &&
      version >= 0
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

async function currentSession(
  supabase: Pick<NativeRefreshSupabase, "auth">,
): Promise<NativeRefreshSession | null> {
  try {
    return (await supabase.auth.getSession()).data.session;
  } catch {
    return null;
  }
}

/**
 * A `refreshOn` trigger for an Expo app on Supabase: on each message on the
 * user's private `authz:<uid>` topic it refreshes the Supabase session, then
 * reconnects PowerSync so streams that read token claims see the new ones, then
 * refreshes the snapshot. Passes run one at a time; signals during a pass fold
 * into one more. The channel closes in the background and rejoins on
 * foreground, where one catch-up pass runs: a version check with
 * `powersync.source` or `powersync.manifest`, else a full pass. It never
 * imports `@supabase/*` or `@powersync/*`.
 */
export function nativeRefresh<C extends RealtimeRefreshChannel, K = unknown>(
  options: NativeRefreshOptions<C, K>,
): RefreshTrigger {
  const { supabase, powersync } = options;
  const versionRows = powersync?.manifest?.rows?.version;
  const source = powersync?.source;
  return (refresh) => {
    let closed = false;
    let online = true;
    let held = false;
    let running = false;
    let again = false;
    let channel: C | undefined;
    let joins = 0;
    let watching: AbortController | undefined;

    const pass = async (): Promise<void> => {
      try {
        await supabase.auth.refreshSession();
        if (powersync !== undefined) {
          await powersync.db.disconnect();
          await powersync.db.connect(powersync.connector);
        }
      } catch {
        // The snapshot still re-reads; the next signal retries the session.
      }
      if (!closed) {
        refresh();
      }
    };

    const signal = (): void => {
      if (closed) {
        return;
      }
      if (!online) {
        held = true;
        return;
      }
      if (running) {
        again = true;
        return;
      }
      running = true;
      void pass().finally(() => {
        running = false;
        if (again) {
          again = false;
          signal();
        }
      });
    };

    const versionSql =
      versionRows === undefined ? undefined : authzVersionQuery(versionRows);
    const catchUp = source !== undefined || versionSql !== undefined;

    const syncedVersion = async (user: string): Promise<number | undefined> => {
      if (source !== undefined) {
        return source.authzVersion();
      }
      return versionSql === undefined || powersync === undefined
        ? undefined
        : highestVersion(await powersync.db.getAll(versionSql, [user]));
    };

    const checkVersion = async (): Promise<void> => {
      if (!catchUp) {
        return;
      }
      const current = await currentSession(supabase);
      if (current === null || closed) {
        return;
      }
      const token = tokenVersion(current.access_token);
      try {
        const synced = await syncedVersion(current.user.id);
        if (token !== undefined && synced !== undefined && synced > token) {
          signal();
        }
      } catch {
        // An unreadable table answers nothing; the topic still signals.
      }
    };

    const leave = (): void => {
      joins += 1;
      if (channel !== undefined) {
        supabase.removeChannel(channel);
        channel = undefined;
      }
    };

    const join = async (): Promise<void> => {
      joins += 1;
      const generation = joins;
      const current = await currentSession(supabase);
      if (closed || generation !== joins || current === null) {
        return;
      }
      channel = supabase.channel(authzUserTopic(current.user.id), {
        config: { private: true },
      });
      channel.on("broadcast", { event: AUTHZ_EVENT }, () => {
        signal();
      });
      channel.subscribe();
      if (
        versionSql !== undefined &&
        powersync !== undefined &&
        watching === undefined
      ) {
        watching = new AbortController();
        powersync.db.watch(
          versionSql,
          [current.user.id],
          {
            onResult: () => {
              void checkVersion();
            },
          },
          { signal: watching.signal },
        );
      }
    };

    void join();
    const offForeground = appStateForeground(options.appState)((active) => {
      leave();
      if (active === false) {
        return;
      }
      void join();
      if (catchUp) {
        void checkVersion();
      } else {
        signal();
      }
    });
    const offOnline =
      options.netInfo === undefined
        ? undefined
        : netInfoOnline(options.netInfo)((next) => {
            online = next;
            if (next && held) {
              held = false;
              signal();
            }
          });
    return () => {
      closed = true;
      leave();
      offForeground();
      offOnline?.();
      watching?.abort();
    };
  };
}
