import { createSvelteStore } from "../../src/svelte/context.ts";
import { testClientStore } from "../../src/testing/client-store.ts";

testClientStore("permdock/svelte createSvelteStore", (options) =>
  createSvelteStore(options),
);
