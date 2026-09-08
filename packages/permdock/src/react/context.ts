import { type Context, createContext } from 'react';

import type { ClientStore } from './store.ts';

export const PermDockStoreContext: Context<ClientStore | null> =
  createContext<ClientStore | null>(null);
