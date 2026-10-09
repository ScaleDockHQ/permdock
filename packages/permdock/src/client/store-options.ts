import type { Snapshot } from "../core/interfaces.ts";
import type { Permission } from "../core/permissions.ts";
import type { ClientStore, ClientStoreOptions } from "./store.ts";

import { compact } from "../core/compact.ts";
import { createClientStore } from "./store.ts";

/** The provider options every UI adapter forwards to its client store. */
export type AdapterStoreOptions = Pick<
  ClientStoreOptions,
  | "snapshotUrl"
  | "approvals"
  | "tenant"
  | "fetch"
  | "headers"
  | "maxAge"
  | "verifier"
  | "awaiting"
  | "passCache"
> & {
  /**
   * The AuthZEN evaluations endpoint. `false` never calls one: a check the
   * snapshot cannot answer is denied with reason `server-only`, and the first
   * one logs a hint.
   */
  readonly endpoint?: string | false;
};

/** One hint per store: the first check `endpoint: false` turns into a `server-only` denial. */
function hintOnce(): (permission: Permission) => void {
  let shown = false;
  return (permission) => {
    if (shown) {
      return;
    }
    shown = true;
    // oxlint-disable-next-line no-console -- the one hint for snapshot-only mode
    console.info(
      `PermDock: ${permission.key} needs the server (a closure, graph relation or period grant) and endpoint is false, so it is denied with reason server-only; check it on the server instead`,
    );
  };
}

/** Store options only the React Native provider sets. */
type NativeStoreHooks = Pick<
  ClientStoreOptions,
  "server" | "stale" | "onSnapshot" | "onClear"
>;

export function adapterStore(
  options: AdapterStoreOptions,
  snapshot: Snapshot | string,
  native?: NativeStoreHooks,
): ClientStore {
  return createClientStore(
    compact({
      snapshot,
      endpoint: options.endpoint === false ? undefined : options.endpoint,
      onServerOnly: options.endpoint === false ? hintOnce() : undefined,
      snapshotUrl: options.snapshotUrl,
      approvals: options.approvals,
      tenant: options.tenant,
      fetch: options.fetch,
      headers: options.headers,
      maxAge: options.maxAge,
      verifier: options.verifier,
      awaiting: options.awaiting,
      passCache: options.passCache,
      server: native?.server,
      stale: native?.stale,
      onSnapshot: native?.onSnapshot,
      onClear: native?.onClear,
    }),
  );
}
