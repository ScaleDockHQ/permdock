import type { InjectionKey } from "vue";

import type { ClientStore } from "../client/store.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { PermDockDefaults } from "./types.ts";

export const permDockKey: InjectionKey<ClientStore> = Symbol("permdock");

/** The plugin's `defaults` and `messages`. */
export type PermDockUi = {
  readonly defaults?: PermDockDefaults | undefined;
  readonly messages?: DescribeMessages | undefined;
};

export const permDockUiKey: InjectionKey<PermDockUi> = Symbol("permdock-ui");
