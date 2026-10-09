import type { Snapshot, TokenVerifier } from "../core/interfaces.ts";
import type { AdapterStoreOptions } from "./store-options.ts";
import type { ClientStore } from "./store.ts";

import { compact } from "../core/compact.ts";
import { emptySnapshot } from "../core/from-snapshot.ts";
import { isPromiseLike } from "./source.ts";
import { adapterStore } from "./store-options.ts";

type Headers = Readonly<Record<string, string>>;

type LiveRead = () => {
  readonly headers?: Headers | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly verifier?: TokenVerifier | undefined;
};

/**
 * Store options that read `read()` on every request, so a rotated token, a
 * new `fetch` or a new verifier applies without rebuilding the store. A
 * verifier is wired only when one is present at creation: it switches the
 * store to signed snapshots.
 */
function liveOptions(
  read: LiveRead,
): Pick<AdapterStoreOptions, "headers" | "fetch" | "verifier"> {
  const verifier: TokenVerifier = {
    verify: (token, expectations) => {
      const current = read().verifier;
      return current === undefined
        ? Promise.reject(
            new Error("PermDock: the verifier option was removed."),
          )
        : current.verify(token, expectations);
    },
  };
  return compact({
    headers: () => read().headers,
    fetch: (...args: Parameters<typeof fetch>): Promise<Response> =>
      (read().fetch ?? fetch)(...args),
    verifier: read().verifier === undefined ? undefined : verifier,
  });
}

/** The options the Vue, Svelte and Solid providers read once, when they build the store. */
type ProviderStoreOptions = Pick<
  AdapterStoreOptions,
  "endpoint" | "snapshotUrl" | "approvals" | "maxAge"
> & { readonly tenant?: string | undefined };

/**
 * The store a Vue, Svelte or Solid provider owns. A promised snapshot keeps
 * it `pending` until the promise settles; `undefined` starts empty.
 */
export function providerStore(
  options: ProviderStoreOptions,
  read: LiveRead,
  snapshot: Snapshot | string | PromiseLike<Snapshot | string> | undefined,
): ClientStore {
  const promised = isPromiseLike(snapshot);
  const store = adapterStore(
    compact({
      endpoint: options.endpoint,
      snapshotUrl: options.snapshotUrl,
      approvals: options.approvals,
      tenant: options.tenant,
      maxAge: options.maxAge,
      ...liveOptions(read),
    }),
    promised || snapshot === undefined ? emptySnapshot() : snapshot,
  );
  if (promised) {
    store.follow(snapshot);
  }
  return store;
}

/** Refreshes for the tenant a reactive `tenant` option switched to; a failed refresh keeps the current answers. */
export function switchTenant(
  store: ClientStore,
  tenant: string | undefined,
): void {
  if (tenant !== undefined) {
    store
      .get()
      .refresh({ tenant })
      .catch(() => undefined);
  }
}
