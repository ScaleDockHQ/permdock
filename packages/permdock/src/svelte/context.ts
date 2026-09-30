import { getContext, onDestroy, setContext } from 'svelte';
import { toStore, type Readable } from 'svelte/store';

import type { Snapshot } from '../core/interfaces.ts';
import type { ClientStore } from '../react/store.ts';
import type { PermDockSvelteOptions } from './types.ts';

import { compact } from '../core/compact.ts';
import { emptySnapshot } from '../core/from-snapshot.ts';
import { isPromiseLike } from '../react/source.ts';
import { createClientStore } from '../react/store.ts';

const permDockKey: unique symbol = Symbol('permdock');

function isReadable(value: unknown): value is Readable<Snapshot | string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'subscribe' in value &&
    typeof value.subscribe === 'function'
  );
}

function reactiveSource(
  source: PermDockSvelteOptions['snapshot'],
): Readable<Snapshot | string> | undefined {
  if (typeof source === 'function') {
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
  const store = createClientStore(
    compact({
      snapshot: initial,
      endpoint: options.endpoint,
      approvals: options.approvals,
      tenant: options.tenant,
      fetch: options.fetch,
      headers: options.headers,
      maxAge: options.maxAge,
      verifier: options.verifier,
    }),
  );
  if (promised) {
    store.follow(source);
    return { store, stop: () => undefined };
  }
  if (reactive === undefined) {
    return { store, stop: () => undefined };
  }
  let current = initial;
  const stop = reactive.subscribe((value) => {
    if (value !== current) {
      current = value;
      store.replace(value);
    }
  });
  return { store, stop };
}

export function createSvelteStore(options: PermDockSvelteOptions): ClientStore {
  return connectSvelteStore(options).store;
}

export function providePermDock(options: PermDockSvelteOptions): ClientStore {
  const { store, stop } = connectSvelteStore(options);
  onDestroy(stop);
  setContext(permDockKey, store);
  return store;
}

export function getStore(): ClientStore {
  const store = getContext<ClientStore | undefined>(permDockKey);
  if (store === undefined) {
    throw new Error('PermDock: stores require setPermDock.');
  }
  return store;
}
