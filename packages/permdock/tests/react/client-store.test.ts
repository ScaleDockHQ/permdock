import { createClientStore } from '../../src/react/store.ts';
import { testClientStore } from '../../src/testing/client-store.ts';

testClientStore('permdock/react createClientStore', (options) =>
  createClientStore({ ...options, server: false }),
);
