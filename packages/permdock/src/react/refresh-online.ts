import type { RefreshTrigger } from "../client/refresh-on.ts";

/**
 * A `refreshOn` trigger on window `online`, when the browser regains its
 * connection. `useOffline` retries only navigation, prefetch and Server Action
 * requests, and the snapshot store's own `fetch` settles to `stale` or
 * `server-only` with no retry, so this refreshes it on reconnect. Without a
 * window it never fires.
 */
export function onlineRefresh(): RefreshTrigger {
  return (refresh) => {
    const target: unknown = Reflect.get(globalThis, "window");
    if (!(target instanceof EventTarget)) {
      return () => undefined;
    }
    target.addEventListener("online", refresh);
    return () => {
      target.removeEventListener("online", refresh);
    };
  };
}
