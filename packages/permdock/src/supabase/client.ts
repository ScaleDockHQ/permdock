import type { RefreshTrigger } from "../client/refresh-on.ts";

import { AUTHZ_EVENT, authzUserTopic } from "./authz-topic.ts";

/** The part of a supabase-js `RealtimeChannel` the trigger uses. */
export type RealtimeRefreshChannel = {
  readonly on: (
    type: "broadcast",
    filter: { readonly event: string },
    callback: (message: unknown) => void,
  ) => unknown;
  readonly subscribe: () => unknown;
};

/** The part of a browser supabase-js client the trigger uses. */
export type RealtimeRefreshClient<
  C extends RealtimeRefreshChannel = RealtimeRefreshChannel,
> = {
  readonly channel: (
    topic: string,
    options: { readonly config: { readonly private: boolean } },
  ) => C;
  readonly removeChannel: (channel: C) => unknown;
};

export type SupabaseRealtimeRefreshOptions<
  C extends RealtimeRefreshChannel = RealtimeRefreshChannel,
> = {
  /** The signed-in user's id, the `sub` of their token. */
  readonly userId: string;
  /**
   * A channel on `authz:<userId>` the app already owns. The trigger binds the
   * `changed` event to it and never subscribes or removes it; without it, the
   * trigger is the only owner of the channel it opens and removes.
   */
  readonly channel?: C;
  /**
   * `subscribeForeground` from `permdock/react-native`, or any function of that
   * shape. The trigger's own channel is removed when `active` is `false` and
   * opened again on the return, followed by one `refresh()` for the bumps sent
   * while it was away; an app-owned channel only gets the `refresh()`.
   */
  readonly foreground?: (listener: (active?: boolean) => void) => () => void;
};

/**
 * A `refreshOn` trigger on the user's private `authz:<uid>` Realtime topic,
 * where the generated version trigger sends each bump, for apps without
 * better-supabase. The `realtime.messages` receive policy from
 * `supabase.hook.broadcast` lets each user join only their own topic. With
 * better-supabase, use `authzChangeRefresh` on `SessionProvider` instead.
 */
export function supabaseRealtimeRefresh<C extends RealtimeRefreshChannel>(
  client: RealtimeRefreshClient<C>,
  options: SupabaseRealtimeRefreshOptions<C>,
): RefreshTrigger {
  return (refresh) => {
    let stopped = false;
    const onChange = (): void => {
      if (!stopped) {
        refresh();
      }
    };
    const shared = options.channel;
    if (shared !== undefined) {
      shared.on("broadcast", { event: AUTHZ_EVENT }, onChange);
    }
    const open = (): C | undefined => {
      if (shared !== undefined) {
        return undefined;
      }
      const channel = client.channel(authzUserTopic(options.userId), {
        config: { private: true },
      });
      channel.on("broadcast", { event: AUTHZ_EVENT }, onChange);
      channel.subscribe();
      return channel;
    };
    let owned = open();
    const close = (): void => {
      if (owned !== undefined) {
        client.removeChannel(owned);
        owned = undefined;
      }
    };
    const offForeground = options.foreground?.((active) => {
      if (stopped) {
        return;
      }
      if (active === false) {
        close();
        return;
      }
      owned ??= open();
      refresh();
    });
    return () => {
      stopped = true;
      offForeground?.();
      close();
    };
  };
}
