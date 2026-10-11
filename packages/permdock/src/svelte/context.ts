import { getContext, onDestroy, setContext } from "svelte";
import { toStore, type Readable } from "svelte/store";

import type { ClientStore } from "../client/store.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { PermDockDefaults, PermDockSvelteOptions } from "./types.ts";

import { providerStore, switchTenant } from "../client/provider-store.ts";
import { isPromiseLike } from "../client/source.ts";
import { compact } from "../core/compact.ts";

const permDockKey: unique symbol = Symbol("permdock");
const permDockUiKey: unique symbol = Symbol("permdock-ui");

/** The provider's `defaults` and `messages`. */
export type PermDockUi = {
  readonly defaults?: PermDockDefaults | undefined;
  readonly messages?: DescribeMessages | undefined;
};

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
  let initial: Snapshot | string | undefined;
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
  const store = providerStore(
    compact({
      endpoint: options.endpoint,
      snapshotUrl: options.snapshotUrl,
      approvals: options.approvals,
      tenant: typeof tenant === "function" ? tenant() : tenant,
      maxAge: options.maxAge,
      onSnapshot: options.onSnapshot,
      onClear: options.onClear,
      approvalInterval: options.approvalInterval,
    }),
    () => ({
      headers: typeof headers === "function" ? headers() : headers,
      fetch: options.fetch,
      verifier: options.verifier,
    }),
    promised ? source : initial,
  );
  const stops: (() => void)[] = [];
  if (reactive !== undefined) {
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
          switchTenant(store, next);
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
  setContext<PermDockUi>(permDockUiKey, {
    defaults: options.defaults,
    messages: options.messages,
  });
  return store;
}

export function getUi(): PermDockUi {
  return getContext<PermDockUi | undefined>(permDockUiKey) ?? {};
}

export function getStore(): ClientStore {
  const store = getContext<ClientStore | undefined>(permDockKey);
  if (store === undefined) {
    throw new Error("PermDock: stores require setPermDock.");
  }
  return store;
}
