import { getContext, setContext } from 'svelte';

import type { ClientStore } from '../react/store.ts';
import type { PermDockSvelteOptions } from './types.ts';

import { compact } from '../core/compact.ts';
import { createClientStore } from '../react/store.ts';

export const permDockKey: unique symbol = Symbol('permdock');

export function createSvelteStore(options: PermDockSvelteOptions): ClientStore {
  return createClientStore(
    compact({
      snapshot: options.snapshot,
      endpoint: options.endpoint,
      approvals: options.approvals,
      tenant: options.tenant,
      fetch: options.fetch,
      headers: options.headers,
      maxAge: options.maxAge,
      verifier: options.verifier,
    }),
  );
}

export function providePermDock(options: PermDockSvelteOptions): ClientStore {
  const store = createSvelteStore(options);
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
