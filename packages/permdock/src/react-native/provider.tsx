import { type ReactElement, useEffect } from "react";

import type { NativePermDockProviderProps } from "./types.ts";

import { compact } from "../core/compact.ts";
import { PermDockStoreContext } from "../react/context.ts";
import { useKeyed } from "../react/keyed.ts";
import { useLiveOptions } from "../react/live-options.ts";
import { connectSource, createNativeStore } from "./store.ts";

export function PermDockProvider(
  props: NativePermDockProviderProps,
): ReactElement {
  const live = useLiveOptions(props);
  const store = useKeyed(
    () =>
      createNativeStore(
        compact({
          storage: props.storage,
          snapshot: props.snapshot,
          snapshotUrl: props.snapshotUrl,
          endpoint: props.endpoint,
          approvals: props.approvals,
          tenant: props.tenant,
          subjectId: props.subjectId,
          revalidate: props.revalidate,
          subscribeForeground: props.subscribeForeground,
          fetch: live.fetch,
          headers: live.headers,
          maxAge: props.maxAge,
          verifier: live.verifier,
        }),
      ),
    [
      props.storage,
      props.snapshot,
      props.snapshotUrl,
      props.endpoint,
      props.approvals,
      props.tenant,
      props.subjectId,
      props.revalidate,
      props.subscribeForeground,
      live.fetch,
      live.headers,
      props.maxAge,
      live.verifier,
    ],
  );

  useEffect(
    () =>
      props.source === undefined
        ? undefined
        : connectSource(store, props.source),
    [store, props.source],
  );

  useEffect(() => {
    const mode = props.revalidate ?? "launch";
    const refresh = (): void => {
      if (props.snapshotUrl === undefined) {
        return;
      }
      store
        .get()
        .refresh()
        .catch(() => undefined);
    };
    if (mode === "launch" || mode === "focus" || typeof mode === "number") {
      refresh();
    }
    if (typeof mode === "number") {
      const timer = setInterval(refresh, mode * 1000);
      return (): void => {
        clearInterval(timer);
      };
    }
    if (mode === "focus" && props.subscribeForeground !== undefined) {
      return props.subscribeForeground(refresh);
    }
    return undefined;
  }, [store, props.revalidate, props.snapshotUrl, props.subscribeForeground]);

  return (
    <PermDockStoreContext value={store}>{props.children}</PermDockStoreContext>
  );
}
