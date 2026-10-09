import { createElement, use } from "react";
import { renderToString } from "react-dom/server";

import type { ClientStore } from "../../src/client/store.ts";

import { PermDockStoreContext } from "../../src/react/context.ts";
import { PermDockProvider } from "../../src/react/provider.tsx";
import { testClientStore } from "../../src/testing/client-store.ts";

testClientStore("permdock/react PermDockProvider", (options) => {
  let store: ClientStore | null = null;
  function Capture(): null {
    store = use(PermDockStoreContext);
    return null;
  }
  renderToString(
    createElement(PermDockProvider, {
      ...options,
      children: createElement(Capture),
    }),
  );
  if (store === null) {
    throw new Error("PermDockProvider provided no store");
  }
  return store;
});
