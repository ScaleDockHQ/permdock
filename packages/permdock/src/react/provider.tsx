import type { ReactElement } from "react";

import { useLayoutEffect, useMemo } from "react";

import type { PermDockProviderProps } from "./types.ts";

import { adapterStore, compact, emptySnapshot } from "../client/kit.ts";
import {
  PermDockSnapshotPromiseContext,
  PermDockStoreContext,
  PermDockUiContext,
} from "./context.ts";
import { useKeyed } from "./keyed.ts";
import { useLiveOptions } from "./live-options.ts";

export function PermDockProvider(props: PermDockProviderProps): ReactElement {
  const promise = props.snapshotPromise ?? null;
  const suspend = props.suspend === true;
  const awaiting = promise !== null && !suspend;
  const live = useLiveOptions(props);
  const store = useKeyed(
    () =>
      adapterStore(
        compact({
          endpoint: props.endpoint,
          snapshotUrl: props.snapshotUrl,
          approvals: props.approvals,
          tenant: props.tenant,
          fetch: live.fetch,
          headers: live.headers,
          maxAge: props.maxAge,
          verifier: live.verifier,
          awaiting,
          passCache: true,
          onSnapshot: live.onSnapshot,
          onClear: live.onClear,
          approvalInterval: props.approvalInterval,
          refreshOn: props.refreshOn,
        }),
        props.snapshot ?? emptySnapshot(),
      ),
    [
      props.snapshot,
      props.endpoint,
      props.snapshotUrl,
      props.approvals,
      props.tenant,
      live.fetch,
      live.headers,
      props.maxAge,
      live.verifier,
      awaiting,
      live.onSnapshot,
      live.onClear,
      props.approvalInterval,
    ],
  );
  const ui = useMemo(
    () => ({ defaults: props.defaults, messages: props.messages }),
    [props.defaults, props.messages],
  );
  useLayoutEffect(() => {
    if (promise !== null && !suspend) {
      store.track(promise);
    }
  }, [store, promise, suspend]);
  return (
    <PermDockStoreContext value={store}>
      <PermDockUiContext value={ui}>
        <PermDockSnapshotPromiseContext value={suspend ? promise : null}>
          {props.children}
        </PermDockSnapshotPromiseContext>
      </PermDockUiContext>
    </PermDockStoreContext>
  );
}
