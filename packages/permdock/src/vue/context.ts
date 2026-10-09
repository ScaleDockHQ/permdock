import type { InjectionKey } from "vue";

import type { ClientStore } from "../client/store.ts";

export const permDockKey: InjectionKey<ClientStore> = Symbol("permdock");
