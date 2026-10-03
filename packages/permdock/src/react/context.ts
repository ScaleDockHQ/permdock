import { type Context, createContext } from "react";

import type { Snapshot } from "../core/interfaces.ts";
import type { ClientStore } from "./store.ts";

export const PermDockStoreContext: Context<ClientStore | null> =
  createContext<ClientStore | null>(null);

export const PermDockSnapshotPromiseContext: Context<PromiseLike<
  Snapshot | string
> | null> = createContext<PromiseLike<Snapshot | string> | null>(null);
