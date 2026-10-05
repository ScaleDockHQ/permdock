import { createApp, inject } from "vue";

import { testClientStore } from "../../src/testing/client-store.ts";
import { permDockKey } from "../../src/vue/context.ts";
import { permdockPlugin } from "../../src/vue/plugin.ts";

testClientStore("permdock/vue permdockPlugin", (options) => {
  const app = createApp({ render: () => null });
  app.use(permdockPlugin, options);
  const store = app.runWithContext(() => inject(permDockKey));
  if (store === undefined) {
    throw new Error("permdockPlugin provided no store");
  }
  return store;
});
