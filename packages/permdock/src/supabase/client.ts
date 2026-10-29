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

export type SupabaseRealtimeRefreshOptions = {
  /** The signed-in user's id, the `sub` of their token. */
  readonly userId: string;
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
  options: SupabaseRealtimeRefreshOptions,
): RefreshTrigger {
  return (refresh) => {
    const channel = client.channel(authzUserTopic(options.userId), {
      config: { private: true },
    });
    channel.on("broadcast", { event: AUTHZ_EVENT }, refresh);
    channel.subscribe();
    return () => {
      client.removeChannel(channel);
    };
  };
}
