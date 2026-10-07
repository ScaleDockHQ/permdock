import { type ReactElement, useLayoutEffect, useMemo } from "react";

import type { Permission } from "../core/permissions.ts";
import type { PermDockProviderProps } from "./types.ts";

import { adapterStore } from "../client/store-options.ts";
import { compact } from "../core/compact.ts";
import { emptySnapshot } from "../core/from-snapshot.ts";
import {
  PermDockSnapshotPromiseContext,
  PermDockStoreContext,
} from "./context.ts";

/** One hint per provider: the first check `endpoint: false` turns into a `server-only` denial. */
function hintOnce(): (permission: Permission) => void {
  let shown = false;
  return (permission) => {
    if (shown) {
      return;
    }
    shown = true;
    // oxlint-disable-next-line no-console -- the one hint for snapshot-only mode
    console.info(
      `PermDock: ${permission.key} needs the server (a closure, graph relation or period grant) and endpoint is false, so it is denied with reason server-only; check it with getPermission instead`,
    );
  };
}

export function PermDockProvider(props: PermDockProviderProps): ReactElement {
  const promise = props.snapshotPromise ?? null;
  const suspend = props.suspend === true;
  const awaiting = promise !== null && !suspend;
  const store = useMemo(
    () =>
      adapterStore(
        compact({
          endpoint: props.endpoint === false ? undefined : props.endpoint,
          onServerOnly: props.endpoint === false ? hintOnce() : undefined,
          snapshotUrl: props.snapshotUrl,
          approvals: props.approvals,
          tenant: props.tenant,
          fetch: props.fetch,
          headers: props.headers,
          maxAge: props.maxAge,
          verifier: props.verifier,
          awaiting,
        }),
        props.snapshot ?? emptySnapshot(),
      ),
    [
      props.snapshot,
      props.endpoint,
      props.snapshotUrl,
      props.approvals,
      props.tenant,
      props.fetch,
      props.headers,
      props.maxAge,
      props.verifier,
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
