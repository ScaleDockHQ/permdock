import type { Permission } from "../core/permission-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";

import { compact } from "../core/compact.ts";
import {
  type ClientStore,
  type ClientStoreOptions,
  createClientStore,
} from "./store.ts";

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
  | "onSnapshot"
  | "onClear"
  | "approvalInterval"
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

/** Runs both hooks: the one the adapter needs first, then the provider option. */
function both<A extends readonly unknown[]>(
  first: ((...args: A) => void) | undefined,
  second: ((...args: A) => void) | undefined,
): ((...args: A) => void) | undefined {
  if (first === undefined || second === undefined) {
    return first ?? second;
  }
  return (...args) => {
    first(...args);
    second(...args);
  };
}

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
      onSnapshot: both(native?.onSnapshot, options.onSnapshot),
      onClear: both(native?.onClear, options.onClear),
      approvalInterval: options.approvalInterval,
    }),
  );
}
