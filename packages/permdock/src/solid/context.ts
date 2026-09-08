import { createContext, useContext, type Context } from 'solid-js';

import type { ClientStore } from '../react/store.ts';

export const PermDockContext: Context<ClientStore | undefined> = createContext<
  ClientStore | undefined
>(undefined);

export function useStore(): ClientStore {
  const store = useContext(PermDockContext);
  if (store === undefined) {
    throw new Error('PermDock: hooks require <PermDockProvider>.');
  }
  return store;
}
