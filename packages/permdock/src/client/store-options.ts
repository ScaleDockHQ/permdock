import type { Snapshot } from "../core/interfaces.ts";
import type { ClientStore, ClientStoreOptions } from "../react/store.ts";

import { compact } from "../core/compact.ts";
import { createClientStore } from "../react/store.ts";

/** The provider options every UI adapter forwards to its client store. */
export type AdapterStoreOptions = Pick<
  ClientStoreOptions,
  | "endpoint"
  | "snapshotUrl"
  | "approvals"
  | "tenant"
  | "fetch"
  | "headers"
  | "maxAge"
  | "verifier"
  | "onServerOnly"
>;

export function adapterStore(
  options: AdapterStoreOptions,
  snapshot: Snapshot | string,
): ClientStore {
  return createClientStore(
    compact({
      snapshot,
      endpoint: options.endpoint,
      snapshotUrl: options.snapshotUrl,
      approvals: options.approvals,
      tenant: options.tenant,
      fetch: options.fetch,
      headers: options.headers,
      maxAge: options.maxAge,
      verifier: options.verifier,
      onServerOnly: options.onServerOnly,
    }),
  );
}
