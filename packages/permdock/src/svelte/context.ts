import { getContext, onDestroy, setContext } from "svelte";
import { toStore, type Readable } from "svelte/store";

import type { ClientStore } from "../client/store.ts";
import type { Snapshot } from "../core/interfaces.ts";
import type { PermDockSvelteOptions } from "./types.ts";

import { isPromiseLike } from "../client/source.ts";
import { adapterStore, liveOptions } from "../client/store-options.ts";
import { compact } from "../core/compact.ts";
import { emptySnapshot } from "../core/from-snapshot.ts";

const permDockKey: unique symbol = Symbol("permdock");

function isReadable(value: unknown): value is Readable<Snapshot | string> {
  return (
    typeof value === "object" &&
    value !== null &&
    "subscribe" in value &&
    typeof value.subscribe === "function"
  );
}

function reactiveSource(
  source: PermDockSvelteOptions["snapshot"],
): Readable<Snapshot | string> | undefined {
  if (typeof source === "function") {
    return toStore(source);
  }
  return isReadable(source) ? source : undefined;
}

/**
 * Builds the store; the returned `stop` ends the subscription to a reactive
 * snapshot source.
 */
function connectSvelteStore(options: PermDockSvelteOptions): {
  readonly store: ClientStore;
  readonly stop: () => void;
} {
  const source = options.snapshot;
  const promised = isPromiseLike(source);
  const reactive = promised ? undefined : reactiveSource(source);
  let initial: Snapshot | string = emptySnapshot();
  if (reactive !== undefined) {
    reactive.subscribe((value) => {
      initial = value;
    })();
  } else if (!promised) {
    // SAFETY: not a promise, function or store, so it is the plain Snapshot or string the option allows.
    initial = source as Snapshot | string;
  }
  const tenant = options.tenant;
  const headers = options.headers;
  const store = adapterStore(
    compact({
      endpoint: options.endpoint,
      snapshotUrl: options.snapshotUrl,
      approvals: options.approvals,
      tenant: typeof tenant === "function" ? tenant() : tenant,
      maxAge: options.maxAge,
      ...liveOptions(() => ({
        headers: typeof headers === "function" ? headers() : headers,
        fetch: options.fetch,
        verifier: options.verifier,
      })),
    }),
    initial,
  );
  const stops: (() => void)[] = [];
  if (promised) {
    store.follow(source);
  } else if (reactive !== undefined) {
    let current = initial;
    stops.push(
      reactive.subscribe((value) => {
        if (value !== current) {
          current = value;
          store.replace(value);
        }
      }),
    );
  }
  if (typeof tenant === "function") {
    let active = tenant();
    stops.push(
      toStore(tenant).subscribe((next) => {
        if (next !== undefined && next !== active) {
          active = next;
          store
            .get()
            .refresh({ tenant: next })
            .catch(() => undefined);
        }
      }),
    );
  }
  return {
    store,
    stop: () => {
      for (const stop of stops) {
        stop();
      }
    },
  };
}

export function createSvelteStore(options: PermDockSvelteOptions): ClientStore {
  return connectSvelteStore(options).store;
}

export function providePermDock(options: PermDockSvelteOptions): ClientStore {
  const { store, stop } = connectSvelteStore(options);
  onDestroy(() => {
    stop();
    store.dispose();
  });
  setContext(permDockKey, store);
  return store;
}

export function getStore(): ClientStore {
  const store = getContext<ClientStore | undefined>(permDockKey);
  if (store === undefined) {
    throw new Error("PermDock: stores require setPermDock.");
  }
  return store;
}
