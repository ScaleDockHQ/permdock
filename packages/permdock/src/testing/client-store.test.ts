import { createNativeStore, memoryStorage } from '../react-native/index.ts';
import { testClientStore } from './client-store.ts';

testClientStore('permdock/react-native createNativeStore', (options) =>
  createNativeStore({ ...options, storage: memoryStorage() }),
);
