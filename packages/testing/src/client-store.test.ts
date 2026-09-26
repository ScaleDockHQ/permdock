import { createNativeStore, memoryStorage } from 'permdock/react-native';

import { testClientStore } from './client-store.ts';

testClientStore('permdock/react-native createNativeStore', (options) =>
  createNativeStore({ ...options, storage: memoryStorage() }),
);
