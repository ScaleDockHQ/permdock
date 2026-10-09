import { createClientStore } from "../../src/client/store.ts";
import { testClientStore } from "../../src/testing/client-store.ts";

testClientStore("permdock/react createClientStore", (options) =>
  createClientStore({ ...options, server: false }),
);
