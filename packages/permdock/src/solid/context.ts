import type { Context } from "solid-js";

import { createContext, useContext } from "solid-js";

import type { ClientStore } from "../client/store.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { PermDockDefaults } from "./types.ts";

export const PermDockContext: Context<ClientStore | undefined> = createContext<
  ClientStore | undefined
>(undefined);

/** The provider's `defaults` and `messages`. */
export type PermDockUi = {
  readonly defaults?: PermDockDefaults | undefined;
  readonly messages?: DescribeMessages | undefined;
};

export const PermDockUiContext: Context<PermDockUi> = createContext<PermDockUi>(
  {},
);

export function useStore(): ClientStore {
  const store = useContext(PermDockContext);
  if (store === undefined) {
    throw new Error("PermDock: hooks require <PermDockProvider>.");
  }
  return store;
}
