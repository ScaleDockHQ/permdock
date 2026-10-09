import { createComponent, createRoot } from "solid-js";

import type { ClientStore } from "../../src/client/store.ts";

import { useStore } from "../../src/solid/context.ts";
import { PermDockProvider } from "../../src/solid/provider.ts";
import { testClientStore } from "../../src/testing/client-store.ts";

testClientStore("permdock/solid PermDockProvider", (options) => {
  let store: ClientStore | undefined;
  createRoot(() =>
    createComponent(PermDockProvider, {
      ...options,
      get children() {
        store = useStore();
        return null;
      },
    }),
  );
  if (store === undefined) {
    throw new Error("PermDockProvider provided no store");
  }
  return store;
});
