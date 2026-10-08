import { type ReactElement, useLayoutEffect } from "react";

import type { PermDockProviderProps } from "./types.ts";

import { adapterStore } from "../client/store-options.ts";
import { compact } from "../core/compact.ts";
import { emptySnapshot } from "../core/from-snapshot.ts";
import {
  PermDockSnapshotPromiseContext,
  PermDockStoreContext,
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
    ],
  );
  useLayoutEffect(() => {
    if (promise !== null && !suspend) {
      store.track(promise);
    }
  }, [store, promise, suspend]);
  return (
    <PermDockStoreContext value={store}>
      <PermDockSnapshotPromiseContext value={suspend ? promise : null}>
        {props.children}
      </PermDockSnapshotPromiseContext>
    </PermDockStoreContext>
  );
}
