import type { SubscribeForeground, SubscribeOnline } from "./types.ts";

/** The `AppState` export of `react-native`, as `appStateForeground` calls it. */
export type AppStateModule = {
  addEventListener(
    type: "change",
    listener: (state: string) => void,
  ): { remove(): void };
};

/** The default export of `@react-native-community/netinfo`, as `netInfoOnline` calls it. */
export type NetInfoModule = {
  addEventListener(
    listener: (state: {
      readonly isConnected: boolean | null;
      readonly isInternetReachable?: boolean | null;
    }) => void,
  ): () => void;
};

/**
 * `subscribeForeground` over `AppState`: `active` returns to the foreground
 * and `background` leaves it. iOS `inactive` (a system sheet over the app) is
 * neither.
 */
export function appStateForeground(
  appState: AppStateModule,
): SubscribeForeground {
  return (listener) => {
    const subscription = appState.addEventListener("change", (state) => {
      if (state === "active") {
        listener(true);
      } else if (state === "background") {
        listener(false);
      }
    });
    return () => {
      subscription.remove();
    };
  };
}

/** `subscribeOnline` over NetInfo. An unknown (`null`) connection counts as online. */
export function netInfoOnline(netInfo: NetInfoModule): SubscribeOnline {
  return (listener) =>
    netInfo.addEventListener((state) => {
      listener(
        state.isConnected !== false && state.isInternetReachable !== false,
      );
    });
}
