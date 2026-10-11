import { type Context, createContext } from "react";

import type { ClientStore } from "../client/store.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { Snapshot } from "../core/interfaces.ts";
import type { PermDockDefaults } from "./types.ts";

export const PermDockStoreContext: Context<ClientStore | null> =
  createContext<ClientStore | null>(null);

/** The provider's `defaults` and `messages`. */
export type PermDockUi = {
  readonly defaults?: PermDockDefaults | undefined;
  readonly messages?: DescribeMessages | undefined;
};

export const PermDockUiContext: Context<PermDockUi> = createContext<PermDockUi>(
  {},
);

export const PermDockSnapshotPromiseContext: Context<PromiseLike<
  Snapshot | string
> | null> = createContext<PromiseLike<Snapshot | string> | null>(null);
