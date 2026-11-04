import { createElement, use } from "react";
import { renderToString } from "react-dom/server";

import type { ClientStore } from "../../src/client/store.ts";

import { PermDockStoreContext } from "../../src/react/context.ts";
import { PermDockProvider } from "../../src/react/provider.tsx";
import { testClientStore } from "../../src/testing/client-store.ts";

testClientStore("permdock/react PermDockProvider", async (options) => {
  const held: { store: ClientStore | undefined } = { store: undefined };
  function Capture(): null {
    held.store = use(PermDockStoreContext) ?? undefined;
    return null;
  }
  renderToString(
    createElement(PermDockProvider, {
      ...options,
      children: createElement(Capture),
    }),
  );
  const { store } = held;
  if (store === undefined) {
    throw new Error("PermDockProvider provided no store");
  }
  // The provider loads the evaluator on demand; tests read the store directly.
  await store.loading();
  return store;
});
